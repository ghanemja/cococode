/**
 * The session controller: owns the model connection, tools, permissions,
 * hooks, MCP servers and the main agent. The interactive UI and headless
 * mode are both thin layers over this.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentEvent, PermissionAnswer, PermissionPrompt } from '../agent/loop.ts';
import { Agent } from '../agent/loop.ts';
import { buildSubagentPrompt, buildSystemPrompt, gatherEnv, type EnvInfo } from '../agent/systemPrompt.ts';
import type { AgentDefinition, CustomCommand, OutputStyle, SkillDefinition } from '../config/extensions.ts';
import { expandSkill, findAgent, loadAgents, loadCommands, loadOutputStyles, loadSkills, modelVisibleSkills, skillListing, userInvocableSkills, BUILTIN_AGENTS, BUILTIN_STYLES } from '../config/extensions.ts';
import { configDir, displayPath, expandHome, readJsonFile, writeJsonFile } from '../config/paths.ts';
import type { LoadedSettings, Settings } from '../config/settings.ts';
import { DEFAULTS, loadSettings, mergeSettings, updateSettingsFile } from '../config/settings.ts';
import { HookRunner } from '../hooks/hooks.ts';
import { loadMcpServers } from '../mcp/config.ts';
import { McpManager } from '../mcp/manager.ts';
import type { MemoryFile } from '../memory/memory.ts';
import { autoMemoryPrompt, loadAutoMemory } from '../memory/autoMemory.ts';
import { loadMemory, loadedPaths, onDemandInstructions, renderMemory, renderOnDemand } from '../memory/memory.ts';
import { PermissionManager } from '../permissions/manager.ts';
import type { DetectedServer, ModelInfo, Provider } from '../providers/index.ts';
import { ModelClient, ProviderError, createProvider, detectServers, profileModel, providerConfigs, rankModels, resolveProvider } from '../providers/index.ts';
import { SessionState } from '../session/state.ts';
import type { SessionSummary } from '../session/store.ts';
import { Transcript, cleanupOldSessions, loadSession } from '../session/store.ts';
import { looksBinary } from '../tools/fsutil.ts';
import { walkFiles } from '../tools/search.ts';
import { inlineBashRunner } from '../commands/inline.ts';
import { renderSkill } from '../tools/meta.ts';
import { builtinTools, filterTools, withoutTools } from '../tools/registry.ts';
import type { AskQuestion, RuntimeHandle, SkillInvocation, SubagentRequest, SubagentResult, Tool, ToolContext } from '../tools/types.ts';
import type { ContentPart, ImagePart, Message, PermissionMode, UserMessage } from '../types.ts';
import { messageText } from '../types.ts';
import { VERSION } from '../version.ts';

/** Interactive services supplied by the UI. All optional: headless mode has none. */
export interface UiBridge {
  requestPermission?(prompt: PermissionPrompt): Promise<PermissionAnswer>;
  askUser?(questions: AskQuestion[], signal: AbortSignal): Promise<Record<string, string> | null>;
  approvePlan?(plan: string, signal: AbortSignal): Promise<{ approved: boolean; feedback?: string; mode?: PermissionMode }>;
  todosChanged?(): void;
}

export interface ControllerOptions {
  cwd: string;
  /** Settings from flags (model, provider, permissions.defaultMode, ...). */
  overrides?: Settings;
  /** --settings */
  extraSettings?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** --tools: restrict the tool set by name. */
  toolFilter?: string[];
  addDirs?: string[];
  mcpConfigFiles?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
  /** Do not write a transcript (--no-session-persistence). */
  persist?: boolean;
  interactive: boolean;
  /** Use this id for the session instead of a generated one (--session-id). */
  sessionId?: string;
  /** Name for the session, usable with --resume (--name). */
  sessionName?: string;
  /** Skip everything user- or project-defined: memory files, hooks, MCP servers, skills, commands, agents (--bare, --safe-mode). */
  bare?: boolean;
  /** Use only the MCP servers given with --mcp-config (--strict-mcp-config). */
  strictMcp?: boolean;
  /** Subagents defined for this session only (--agents). */
  extraAgents?: AgentDefinition[];
  /** Run the main conversation as this agent: its prompt, tools and model (--agent). */
  agent?: string;
}

const SUBAGENT_EXCLUDED = new Set(['Agent', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

interface AppState {
  trustedProjects?: string[];
}

function statePath(): string {
  return path.join(configDir(), 'state.json');
}

export class Controller implements RuntimeHandle {
  readonly opts: ControllerOptions;
  loaded: LoadedSettings;
  settings: Settings;
  session: SessionState;
  permissions: PermissionManager;
  hooks: HookRunner;
  transcript: Transcript;
  mcp?: McpManager;
  mcpErrors: string[] = [];
  provider!: Provider;
  client!: ModelClient;
  agent!: Agent;
  env!: EnvInfo;
  detected: DetectedServer[] = [];
  commands: CustomCommand[] = [];
  agentDefs: AgentDefinition[] = [];
  skillDefs: SkillDefinition[] = [];
  styles: OutputStyle[] = [];
  memory: MemoryFile[] = [];
  ui: UiBridge = {};
  /** Messages typed while a turn is running; delivered at the next opportunity. */
  queued: UserMessage[] = [];
  startedAt = Date.now();
  private abortController: AbortController | null = null;
  private builtin: Tool[] = builtinTools();
  private memoryText = '';

  constructor(opts: ControllerOptions) {
    this.opts = opts;
    this.loaded = loadSettings({ projectRoot: opts.cwd, extra: opts.extraSettings, overrides: opts.overrides });
    this.settings = this.loaded.merged;
    this.session = new SessionState({ id: opts.sessionId, cwd: opts.cwd, settings: this.settings });
    for (const dir of opts.addDirs ?? []) this.session.addDir(dir);
    this.permissions = this.makePermissions();
    this.transcript = this.makeTranscript();
    this.hooks = this.makeHooks();
    this.sessionName = opts.sessionName;
    this.reloadExtensions();
    const main = this.mainAgent();
    if (opts.agent && !main) {
      throw new Error(`No agent named "${opts.agent}". Available: ${this.agentDefs.map((a) => a.name).join(', ')}.`);
    }
    // The agent's model applies unless one was asked for on the command line.
    if (main?.model && !opts.overrides?.model) this.settings.model = main.model;
  }

  /** The agent the main conversation runs as, when --agent (or the `agent` setting) names one. */
  mainAgent(): AgentDefinition | undefined {
    const name = this.opts.agent ?? this.settings.agent;
    return name ? findAgent(this.agentDefs, name) : undefined;
  }

  /** Name shown in session lists and accepted by --resume. Written with the first message. */
  sessionName: string | undefined;
  private nameWritten = false;

  rename(name: string): void {
    this.sessionName = name.trim() || undefined;
    this.nameWritten = false;
    this.writeName();
  }

  /** The transcript file only exists once there is a message, so the name is written then. */
  private writeName(): void {
    if (this.nameWritten || !this.sessionName || !this.agent?.messages.length) return;
    this.transcript.title(this.sessionName);
    this.nameWritten = true;
  }

  private makePermissions(): PermissionManager {
    const manager = this.newPermissionManager();
    manager.autoMemory = !this.opts.bare && (this.settings.autoMemoryEnabled ?? true);
    return manager;
  }

  private newPermissionManager(): PermissionManager {
    return new PermissionManager(this.session, {
      settings: this.settings.permissions,
      mode: this.opts.overrides?.permissions?.defaultMode,
      allow: this.opts.allowedTools,
      deny: this.opts.disallowedTools,
    });
  }

  private makeTranscript(existing = false): Transcript {
    return new Transcript(this.session.projectRoot, this.session.id, VERSION, {
      persist: this.opts.persist ?? true,
      model: this.settings.model,
      existing,
    });
  }

  private makeHooks(): HookRunner {
    return new HookRunner(() => (this.settings.disableAllHooks || this.opts.bare ? undefined : this.settings.hooks), {
      sessionId: this.session.id,
      transcriptPath: this.transcript.path,
      projectRoot: this.session.projectRoot,
      cwd: () => this.session.cwd,
      permissionMode: () => this.permissions.mode,
    });
  }

  get claudeCompat(): boolean {
    return this.settings.claudeCompat ?? true;
  }

  /** Re-read commands, agents, skills, output styles and memory files from disk. */
  reloadExtensions(): void {
    const root = this.session.projectRoot;
    if (this.opts.bare) {
      // Nothing user- or project-defined: only what ships with coco.
      this.commands = [];
      this.agentDefs = [...(this.opts.extraAgents ?? []), ...BUILTIN_AGENTS];
      this.skillDefs = [];
      this.styles = BUILTIN_STYLES;
      this.memory = [];
      this.memoryText = '';
      return;
    }
    this.commands = loadCommands(root, this.claudeCompat);
    // Agents given on the command line win over files of the same name.
    this.agentDefs = loadAgents(root, this.claudeCompat, this.opts.extraAgents ?? []);
    this.skillDefs = loadSkills(root, this.claudeCompat);
    this.styles = loadOutputStyles(root, this.claudeCompat);
    this.memory = loadMemory(root, this.claudeCompat, this.memoryExcludes());
    this.deliveredInstructions = loadedPaths(this.memory);
    // Auto memory is read once per session: changing the system prompt mid-session would
    // make a local server re-evaluate the whole prompt on the next request.
    const auto = this.autoMemoryOn() ? autoMemoryPrompt(loadAutoMemory(root)) : '';
    this.memoryText = [renderMemory(this.memory), auto].filter(Boolean).join('\n\n');
    if (this.permissions) this.permissions.autoMemory = this.autoMemoryOn();
  }

  /** Instruction files already given to the model, so each is delivered once. */
  private deliveredInstructions = new Set<string>();

  private memoryExcludes(): string[] {
    // Instruction files inside dependencies were not written for this project.
    return ['**/node_modules/**', ...(this.settings.claudeMdExcludes ?? [])];
  }

  private autoMemoryOn(): boolean {
    return !this.opts.bare && (this.settings.autoMemoryEnabled ?? true);
  }

  /**
   * Instructions that apply to a file the model just read or edited and were not
   * loaded at launch: memory files in its directory, and rules scoped to its path.
   */
  private instructionsFor(toolName: string, input: Record<string, unknown>): string | undefined {
    if (this.opts.bare) return undefined;
    const raw = toolName === 'NotebookEdit' ? input.notebook_path : toolName === 'Read' || toolName === 'Edit' || toolName === 'Write' ? input.file_path : undefined;
    if (typeof raw !== 'string' || !raw) return undefined;
    const abs = path.resolve(this.session.cwd, expandHome(raw));
    const files = onDemandInstructions(this.session.projectRoot, abs, this.claudeCompat, this.deliveredInstructions, this.memoryExcludes());
    return files.length ? renderOnDemand(files) : undefined;
  }

  // ------------------------------------------------------------- workspace trust

  /** True when project files would make coco run commands (hooks, MCP servers, status line). */
  projectRunsCode(): boolean {
    const projectScopes = new Set(['project', 'local', 'claude-project', 'claude-local']);
    const fromSettings = this.loaded.sources.some(
      (s) => projectScopes.has(s.scope) && (Object.keys(s.settings.hooks ?? {}).length > 0 || s.settings.statusLine || s.settings.mcpServers),
    );
    return fromSettings || fs.existsSync(path.join(this.session.projectRoot, '.mcp.json'));
  }

  isTrusted(): boolean {
    const state = readJsonFile<AppState>(statePath());
    return state?.trustedProjects?.includes(this.session.projectRoot) ?? false;
  }

  trustProject(): void {
    const state = readJsonFile<AppState>(statePath()) ?? {};
    state.trustedProjects = [...new Set([...(state.trustedProjects ?? []), this.session.projectRoot])];
    writeJsonFile(statePath(), state);
  }

  /** Drop everything from project files that would execute code. */
  distrustProject(): void {
    const projectScopes = new Set(['project', 'local', 'claude-project', 'claude-local']);
    const cleaned = this.loaded.sources.map((s) => {
      if (!projectScopes.has(s.scope)) return s.settings;
      const { hooks: _h, statusLine: _s, mcpServers: _m, env: _e, ...rest } = s.settings;
      return rest;
    });
    this.settings = mergeSettings(...cleaned);
    this.session.settings = this.settings;
    this.untrusted = true;
  }

  private untrusted = false;

  // --------------------------------------------------------------- model + MCP

  /**
   * Connect to a model server. `pick` lets the UI ask the user to choose when
   * no model is configured and the server has several.
   */
  async connect(pick?: (models: ModelInfo[], provider: Provider) => Promise<string | undefined>): Promise<void> {
    const resolved = await resolveProvider(this.settings);
    this.provider = resolved.provider;
    this.detected = resolved.detected ?? [];
    let model = resolved.model;

    let available: ModelInfo[] | undefined;
    try {
      available = await this.provider.listModels();
    } catch (err) {
      // Hosted endpoints may not list models; only fail if we have nothing to go on,
      // or if the server cannot be reached at all (retrying a chat request would not help).
      if (!model || (err instanceof ProviderError && err.kind === 'connection')) throw err;
    }
    if (!model) {
      const ranked = rankModels(available ?? []);
      if (ranked.length === 0) {
        throw new ProviderError(
          'model_not_found',
          `${this.provider.name} is running at ${this.provider.baseUrl} but has no chat models.` +
            (this.provider.type === 'ollama' ? ' Pull one first, for example: ollama pull qwen3-coder' : ' Load a model in the server, then try again.'),
        );
      }
      model = ranked.length > 1 && pick ? ((await pick(ranked, this.provider)) ?? ranked[0]!.id) : ranked[0]!.id;
    } else if (available && available.length > 0) {
      const match = matchModel(model, available);
      if (!match) {
        throw new ProviderError(
          'model_not_found',
          `Model "${model}" was not found on ${this.provider.name} (${this.provider.baseUrl}).\nAvailable: ${available.map((m) => m.id).join(', ')}` +
            (this.provider.type === 'ollama' ? `\nTo download it: ollama pull ${model}` : ''),
        );
      }
      model = match;
    }
    await this.useModel(this.provider, model);
    this.env = gatherEnv(this.session.cwd, this.session.projectRoot, this.session.additionalDirs, model);
    this.agent = this.makeAgent();
    // A session resumed before the model was connected (--continue, --resume).
    if (this.resumedMessages) {
      this.agent.load(this.resumedMessages);
      this.resumedMessages = undefined;
    }
  }

  private resumedMessages: Message[] | undefined;

  private async useModel(provider: Provider, model: string): Promise<void> {
    const profile = await profileModel(provider, model, this.settings);
    this.provider = provider;
    this.client = new ModelClient(provider, model, profile, this.settings);
    this.session.vision = profile.vision;
    if (this.env) this.env.model = model;
    // Unless the user chose a limit, one tool result may fill at most a fifth of the window:
    // the 30,000-character default suits a 200k-token model, not a 16k one.
    if (this.settings.maxToolOutputChars === undefined || this.derivedOutputCap) {
      this.derivedOutputCap = true;
      this.settings.maxToolOutputChars = Math.max(4000, Math.min(DEFAULTS.maxToolOutputChars, Math.floor(profile.contextWindow * 3.5 * 0.2)));
    }
  }

  private derivedOutputCap = false;

  enterPlanMode(): boolean {
    if (this.permissions.mode === 'bypassPermissions' || this.permissions.mode === 'dontAsk') return false;
    this.permissions.mode = 'plan';
    return true;
  }

  /** Switch model (and optionally provider) mid-session. */
  async setModel(model: string, providerName?: string): Promise<void> {
    let provider = this.provider;
    if (providerName && providerName !== this.provider.name) {
      const config = providerConfigs(this.settings)[providerName];
      if (!config) throw new Error(`Unknown provider "${providerName}".`);
      provider = createProvider(providerName, config);
    }
    await this.useModel(provider, model);
    this.agent.setClient(this.client);
  }

  /** Remember the model choice for future sessions. */
  saveModelChoice(): void {
    updateSettingsFile('user', this.session.projectRoot, (s) => {
      s.model = this.client.model;
      s.provider = this.provider.name === 'custom' ? s.provider : this.provider.name;
    });
  }

  /** Every model on every reachable local server, for the /model picker. */
  async allModels(): Promise<{ provider: string; model: ModelInfo }[]> {
    const servers = await detectServers(this.settings, 1000);
    const out: { provider: string; model: ModelInfo }[] = [];
    for (const server of servers) for (const model of rankModels(server.models)) out.push({ provider: server.name, model });
    if (!servers.some((s) => s.name === this.provider.name)) {
      try {
        for (const model of rankModels(await this.provider.listModels())) out.push({ provider: this.provider.name, model });
      } catch {
        // current provider unreachable; show what we have
      }
    }
    return out;
  }

  async connectMcp(): Promise<void> {
    const { servers, errors } = loadMcpServers(this.session.projectRoot, {
      extraFiles: this.opts.mcpConfigFiles,
      inline: this.settings.mcpServers,
      disabled: this.settings.disabledMcpServers,
    });
    this.mcpErrors = errors;
    if (this.opts.bare && !this.opts.mcpConfigFiles?.length) return;
    const explicitOnly = this.opts.strictMcp || this.opts.bare;
    const usable = explicitOnly ? servers.filter((s) => s.scope === 'flag') : this.untrusted ? servers.filter((s) => s.scope === 'user' || s.scope === 'flag') : servers;
    if (usable.length === 0) return;
    this.mcp = new McpManager(usable, { clientVersion: VERSION, cwd: this.session.projectRoot });
    await this.mcp.connectAll();
  }

  // ---------------------------------------------------------------------- agent

  /**
   * Tools offered to the model right now. Every definition costs context on
   * each request, so tools that cannot be useful in the current state are left
   * out: plan approval outside plan mode, skills when none are installed,
   * notebook editing in a project without notebooks.
   */
  sessionTools(): Tool[] {
    const hidden = new Set<string>();
    // Entering plan mode is offered outside it, leaving it only inside it.
    hidden.add(this.permissions.mode === 'plan' ? 'EnterPlanMode' : 'ExitPlanMode');
    if (this.permissions.mode === 'bypassPermissions' || this.permissions.mode === 'dontAsk') hidden.add('EnterPlanMode');
    if (modelVisibleSkills(this.skillDefs).length === 0) hidden.add('Skill');
    if (!this.projectHasNotebooks()) hidden.add('NotebookEdit');
    const all = [...this.builtin.filter((t) => !hidden.has(t.name)), ...(this.mcp?.tools() ?? [])];
    return filterTools(all, this.opts.toolFilter);
  }

  /** What the main conversation is offered: the session's tools, narrowed when it runs as an agent. */
  tools(): Tool[] {
    const all = this.sessionTools();
    const main = this.mainAgent();
    return main ? withoutTools(filterTools(all, main.tools), main.disallowedTools) : all;
  }

  private hasNotebooks: boolean | undefined;

  private projectHasNotebooks(): boolean {
    // Once the model has read a notebook the tool is needed, wherever the file lives.
    if (!this.hasNotebooks) {
      for (const file of this.session.readFiles.keys()) {
        if (file.endsWith('.ipynb')) return (this.hasNotebooks = true);
      }
    }
    if (this.hasNotebooks === undefined) {
      try {
        this.hasNotebooks = walkFiles(this.session.projectRoot, { limit: 20_000 }).some((f) => f.endsWith('.ipynb'));
      } catch {
        this.hasNotebooks = false;
      }
    }
    return this.hasNotebooks;
  }

  systemPrompt(): string {
    const style = this.styles.find((s) => s.name === (this.settings.outputStyle ?? 'default').toLowerCase());
    return buildSystemPrompt({
      env: { ...this.env, cwd: this.session.cwd, additionalDirs: this.session.additionalDirs },
      memory: this.memoryText,
      mode: this.permissions.mode,
      outputStyle: style?.prompt,
      skills: this.skills(),
      agents: this.tools().some((t) => t.name === 'Agent') ? this.agentTypes() : [],
      mcpInstructions: (this.mcp?.status() ?? []).filter((s) => s.instructions).map((s) => ({ server: s.name, text: s.instructions! })),
      override: this.opts.systemPrompt ?? this.mainAgent()?.prompt,
      append: this.opts.appendSystemPrompt,
    });
  }

  private makeAgent(): Agent {
    return new Agent({
      client: this.client,
      tools: () => this.tools(),
      system: () => this.systemPrompt(),
      session: this.session,
      permissions: this.permissions,
      hooks: this.hooks,
      runtime: this,
      settings: this.settings,
      depth: 0,
      requestPermission: this.ui.requestPermission ? (p) => this.ui.requestPermission!(p) : undefined,
      transcript: this.transcript,
      maxTurns: this.opts.maxTurns,
      drainQueued: () => this.queued.splice(0),
      fallback: (index) => this.fallbackClient(index),
      carryOver: () => ({
        skills: [...this.invokedSkills].map(([name, content]) => ({ name, content })),
        plan: this.approvedPlan,
      }),
      // The repository has usually changed by the time a session is long enough to compact.
      onCompacted: () => {
        this.env = gatherEnv(this.session.cwd, this.session.projectRoot, this.session.additionalDirs, this.client.model);
        // On-demand instructions lived in tool results that are gone now: deliver them again when next relevant.
        this.deliveredInstructions = loadedPaths(this.memory);
      },
      afterTool: (toolName, input) => this.instructionsFor(toolName, input),
    });
  }

  /** Skills invoked this session (most recent last), so compaction can restate them. */
  private invokedSkills = new Map<string, string>();
  /** The plan the user approved in plan mode, restated after compaction. */
  private approvedPlan: string | undefined;
  private fallbackClients = new Map<string, ModelClient>();

  /** The nth configured fallback model, connected on first use. */
  private async fallbackClient(index: number): Promise<ModelClient | undefined> {
    const configured = this.settings.fallbackModel;
    const models = (Array.isArray(configured) ? configured : configured ? [configured] : []).filter((m) => m && m !== this.client.model).slice(0, 3);
    const model = models[index];
    if (!model) return undefined;
    const cached = this.fallbackClients.get(model);
    if (cached) return cached;
    const client = new ModelClient(this.provider, model, await profileModel(this.provider, model, this.settings), this.settings);
    this.fallbackClients.set(model, client);
    return client;
  }

  /** Call after setting `ui` so the agent picks up the interactive callbacks. */
  attachUi(ui: UiBridge): void {
    this.ui = ui;
    if (this.agent) {
      const messages = this.agent.messages;
      const totals = this.agent.totals;
      this.agent = this.makeAgent();
      this.agent.load(messages);
      this.agent.totals = totals;
    }
  }

  get busy(): boolean {
    return this.abortController !== null;
  }

  abort(): void {
    this.abortController?.abort();
  }

  private async *track(gen: (signal: AbortSignal) => AsyncGenerator<AgentEvent>): AsyncGenerator<AgentEvent> {
    const controller = new AbortController();
    this.abortController = controller;
    try {
      yield* gen(controller.signal);
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  /**
   * Send a user prompt. `display` is what the user typed when `text` has been
   * expanded from a slash command.
   */
  submit(text: string, opts: { display?: string; images?: ImagePart[] } = {}): AsyncGenerator<AgentEvent> {
    return this.track((signal) => this.submitInner(text, opts, signal));
  }

  private async *submitInner(text: string, opts: { display?: string; images?: ImagePart[] }, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    let context = '';
    if (this.hooks.has('UserPromptSubmit')) {
      const outcome = await this.hooks.run('UserPromptSubmit', { prompt: text }, undefined, signal);
      for (const m of outcome.messages) yield { type: 'notice', level: 'info', text: m };
      if (outcome.blocked) {
        yield { type: 'notice', level: 'warn', text: `Prompt blocked by a hook: ${outcome.reason ?? 'no reason given'}` };
        yield { type: 'done', reason: 'hook_stop' };
        return;
      }
      if (outcome.additionalContext) context = outcome.additionalContext;
    }
    this.session.turn++;
    const message = this.buildUserMessage(text, opts, context);
    this.agent.messages.push(message);
    this.transcript.message(message);
    this.writeName();
    yield* this.agent.resume(signal);
  }

  /** Expand @file mentions into attached content and wrap up images. */
  buildUserMessage(text: string, opts: { display?: string; images?: ImagePart[] } = {}, hookContext = ''): UserMessage {
    const attached: string[] = [];
    const images: ImagePart[] = [...(opts.images ?? [])];
    const seen = new Set<string>();
    const maxChars = Math.min(this.settings.maxToolOutputChars ?? DEFAULTS.maxToolOutputChars, 20_000);
    const re = /(?:^|[\s(])@((?:~\/|\.{1,2}\/|\/)?[^\s@)]+)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const ref = m[1]!.replace(/[.,;:!?]+$/, '');
      const abs = path.resolve(this.session.cwd, expandHome(ref));
      if (seen.has(abs)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue; // not a path: leave the text alone
      }
      seen.add(abs);
      const shown = displayPath(abs, this.session.cwd);
      if (stat.isDirectory()) {
        const entries = fs
          .readdirSync(abs, { withFileTypes: true })
          .slice(0, 200)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        attached.push(`<directory path="${shown}">\n${entries.join('\n')}\n</directory>`);
        continue;
      }
      const ext = path.extname(abs).toLowerCase();
      if (IMAGE_TYPES[ext]) {
        if (this.session.vision && stat.size <= 5 * 1024 * 1024) {
          images.push({ type: 'image', mediaType: IMAGE_TYPES[ext]!, data: fs.readFileSync(abs).toString('base64') });
        } else {
          attached.push(`<file path="${shown}">[image not attached: ${this.session.vision ? 'larger than 5 MB' : 'the current model does not accept images'}]</file>`);
        }
        continue;
      }
      const buf = fs.readFileSync(abs);
      if (looksBinary(buf)) {
        attached.push(`<file path="${shown}">[binary file, ${stat.size} bytes]</file>`);
        continue;
      }
      const content = buf.toString('utf8');
      const clipped = content.length > maxChars;
      this.session.readFiles.set(abs, { mtimeMs: stat.mtimeMs, partial: clipped });
      attached.push(`<file path="${shown}">\n${clipped ? `${content.slice(0, maxChars)}\n… [truncated: ${content.length - maxChars} more characters; use Read for the rest]` : content}\n</file>`);
    }

    let body = text;
    if (attached.length) body += `\n\n<attached-files>\n${attached.join('\n')}\n</attached-files>`;
    if (hookContext) body += `\n\n<hook-context>\n${hookContext}\n</hook-context>`;
    const content: string | ContentPart[] = images.length ? [{ type: 'text', text: body }, ...images] : body;
    const message: UserMessage = { role: 'user', content, turn: this.session.turn };
    if (opts.display !== undefined || body !== text) message.display = opts.display ?? text;
    return message;
  }

  /** Queue a message typed while the agent is working. */
  enqueue(text: string): void {
    this.session.turn++;
    this.queued.push(this.buildUserMessage(text));
  }

  /** Deliver messages that were queued but not picked up before the turn ended. */
  flushQueued(): AsyncGenerator<AgentEvent> | null {
    if (this.queued.length === 0) return null;
    return this.track(async function* (this: Controller, signal: AbortSignal): AsyncGenerator<AgentEvent> {
      for (const q of this.queued.splice(0)) {
        this.agent.messages.push(q);
        this.transcript.message(q);
        yield { type: 'user_message', message: q };
      }
      yield* this.agent.resume(signal);
    }.bind(this));
  }

  compact(instructions?: string): AsyncGenerator<AgentEvent> {
    return this.track((signal) => this.agent.compact(signal, { auto: false, force: true, instructions }));
  }

  setMode(mode: PermissionMode): void {
    this.permissions.mode = mode;
  }

  // ---------------------------------------------------------- session lifecycle

  /** Start a fresh conversation in the same process (/clear). */
  async clear(): Promise<void> {
    await this.runSessionHook('SessionEnd', { reason: 'clear' });
    this.session.shells.killAll();
    const { additionalDirs } = this.session;
    const mode = this.permissions.mode;
    this.session = new SessionState({ cwd: this.session.projectRoot, settings: this.settings });
    this.session.additionalDirs = additionalDirs;
    this.session.vision = this.client.profile.vision;
    this.permissions = this.makePermissions();
    this.permissions.mode = mode;
    this.transcript = this.makeTranscript();
    this.hooks = this.makeHooks();
    this.queued = [];
    this.invokedSkills.clear();
    this.approvedPlan = undefined;
    const totals = this.agent.totals;
    this.agent = this.makeAgent();
    this.agent.totals = totals;
    this.reloadExtensions();
    await this.runSessionHook('SessionStart', { source: 'clear' }, 'clear');
  }

  /** Load an earlier conversation and continue it. */
  resume(summary: Pick<SessionSummary, 'path'>, opts: { fork?: boolean } = {}): Message[] {
    const loaded = loadSession(summary.path);
    const additionalDirs = this.session.additionalDirs;
    // A fork continues the conversation under a new id and leaves the original untouched.
    const id = opts.fork ? this.opts.sessionId : loaded.id;
    this.session = new SessionState({ id, cwd: this.session.projectRoot, settings: this.settings });
    if (!opts.fork && loaded.title && !this.opts.sessionName) {
      this.sessionName = loaded.title;
      this.nameWritten = true;
    }
    this.session.additionalDirs = additionalDirs;
    this.session.vision = this.client?.profile.vision ?? false;
    // New turns must be numbered above every existing one. After a compaction or a
    // rewind the messages alone can understate that, so the file checkpoints are consulted too.
    let lastTurn = this.session.checkpoints.lastTurn();
    for (const m of loaded.messages) if (m.role === 'user' && (m.turn ?? 0) > lastTurn) lastTurn = m.turn!;
    this.session.turn = lastTurn;
    // Restore the task list from the last TodoWrite call.
    for (let i = loaded.messages.length - 1; i >= 0; i--) {
      const m = loaded.messages[i]!;
      const call = m.role === 'assistant' ? m.toolCalls?.find((c) => c.name === 'TodoWrite') : undefined;
      if (call && Array.isArray(call.arguments.todos)) {
        this.session.todos = call.arguments.todos as SessionState['todos'];
        break;
      }
    }
    const mode = this.permissions.mode;
    this.permissions = this.makePermissions();
    this.permissions.mode = mode;
    this.transcript = this.makeTranscript(!opts.fork);
    // The fork's transcript starts with the whole conversation so far, so it stands alone.
    if (opts.fork && loaded.messages.length) this.transcript.compacted(loaded.messages);
    this.hooks = this.makeHooks();
    if (this.client) {
      const totals = this.agent?.totals;
      this.agent = this.makeAgent();
      this.agent.load(loaded.messages);
      if (totals) this.agent.totals = totals;
    } else {
      this.resumedMessages = loaded.messages;
    }
    return loaded.messages;
  }

  /**
   * Continue the current conversation as a new session (/branch). The original
   * transcript stays as it is and can be resumed separately. Returns its id.
   */
  branch(name?: string): string {
    const previous = this.session.id;
    const messages = this.agent.messages;
    const { additionalDirs, todos, cwd, turn, readFiles, vision } = this.session;
    this.session = new SessionState({ cwd: this.session.projectRoot, settings: this.settings });
    Object.assign(this.session, { additionalDirs, todos, cwd, turn, readFiles, vision });
    const mode = this.permissions.mode;
    this.permissions = this.makePermissions();
    this.permissions.mode = mode;
    this.transcript = this.makeTranscript();
    if (messages.length) this.transcript.compacted(messages);
    this.hooks = this.makeHooks();
    const totals = this.agent.totals;
    this.agent = this.makeAgent();
    this.agent.load(messages);
    this.agent.totals = totals;
    this.sessionName = name?.trim() || undefined;
    this.nameWritten = false;
    this.writeName();
    return previous;
  }

  /** User turns that can be rewound to, oldest first. */
  rewindPoints(): { turn: number; index: number; text: string; filesChanged: number }[] {
    const points: { turn: number; index: number; text: string; filesChanged: number }[] = [];
    this.agent.messages.forEach((m, index) => {
      if (m.role === 'user' && !m.isMeta && m.turn !== undefined) {
        points.push({
          turn: m.turn,
          index,
          text: (m.display ?? messageText(m.content)).replace(/\s+/g, ' ').trim(),
          filesChanged: this.session.checkpoints.changedSince(m.turn).length,
        });
      }
    });
    return points;
  }

  /**
   * Go back to just before a user turn. `conversation` drops that message and
   * everything after it; `code` restores files edited since then.
   */
  rewind(turn: number, what: { conversation: boolean; code: boolean }): { restored: string[]; failed: string[]; prompt?: string } {
    let restored: string[] = [];
    let failed: string[] = [];
    let prompt: string | undefined;
    if (what.code) {
      ({ restored, failed } = this.session.checkpoints.rewindTo(turn));
      for (const file of restored) this.session.readFiles.delete(file);
    }
    if (what.conversation) {
      const index = this.agent.messages.findIndex((m) => m.role === 'user' && m.turn === turn);
      if (index >= 0) {
        const msg = this.agent.messages[index] as UserMessage;
        prompt = msg.display ?? messageText(msg.content);
        this.agent.load(this.agent.messages.slice(0, index));
        this.transcript.truncate(index);
      }
    }
    return { restored, failed, prompt };
  }

  async runSessionHook(event: 'SessionStart' | 'SessionEnd', payload: Record<string, unknown>, subject?: string): Promise<string[]> {
    if (!this.hooks.has(event)) return [];
    const outcome = await this.hooks.run(event, payload, subject);
    if (event === 'SessionStart' && outcome.additionalContext && this.agent) {
      const msg: UserMessage = { role: 'user', isMeta: true, content: `<session-start-hook>\n${outcome.additionalContext}\n</session-start-hook>` };
      this.agent.messages.push(msg);
      this.transcript.message(msg);
    }
    return outcome.messages;
  }

  async shutdown(reason = 'exit'): Promise<void> {
    this.abort();
    try {
      await Promise.race([this.runSessionHook('SessionEnd', { reason }), new Promise((r) => setTimeout(r, 5000))]);
    } catch {
      // hooks must not block exit
    }
    this.session.shells.killAll();
    await this.mcp?.close().catch(() => {});
  }

  startupMaintenance(): void {
    try {
      cleanupOldSessions(this.settings.cleanupPeriodDays ?? DEFAULTS.cleanupPeriodDays);
    } catch {
      // best effort
    }
  }

  // ------------------------------------------------------------- RuntimeHandle

  agentTypes(): { name: string; description: string }[] {
    return this.agentDefs.map((a) => ({ name: a.name, description: a.description }));
  }

  /**
   * Skills the model may load, as listed in the system prompt. The list is paid
   * for on every request, so descriptions shrink to fit about 2% of the window.
   */
  skills(): { name: string; description: string }[] {
    const visible = modelVisibleSkills(this.skillDefs);
    if (visible.length === 0) return [];
    const window = this.client?.profile.contextWindow ?? this.settings.contextWindow ?? DEFAULTS.contextWindow;
    const budget = Math.max(1500, Math.floor(window * 3.5 * 0.02));
    const each = Math.max(60, Math.min(250, Math.floor(budget / visible.length) - 24));
    return visible.map((s) => ({ name: s.name, description: skillListing(s, each) }));
  }

  async invokeSkill(name: string, args: string, by: 'model' | 'user'): Promise<SkillInvocation | undefined> {
    const wanted = name.toLowerCase();
    const pool = by === 'model' ? modelVisibleSkills(this.skillDefs) : userInvocableSkills(this.skillDefs);
    const skill = pool.find((s) => s.name.toLowerCase() === wanted);
    if (!skill) return undefined;
    const body = await expandSkill(skill, args, {
      sessionId: this.session.id,
      projectDir: this.session.projectRoot,
      // Arguments may come from the model, so the runner judges the final command text.
      runBash: inlineBashRunner(this, skill.allowedTools),
    });
    const content = renderSkill(skill.name, skill.baseDir, body);
    if (skill.fork) return { name: skill.name, baseDir: skill.baseDir, content, forkAgent: findAgent(this.agentDefs, skill.agent ?? '')?.name ?? 'general-purpose' };
    // Tools the skill pre-approves stay approved for the rest of the session.
    for (const rule of skill.allowedTools ?? []) this.permissions.addRule('allow', rule);
    // Using a skill is worth remembering (most recent last) so it survives compaction.
    this.invokedSkills.delete(skill.name);
    this.invokedSkills.set(skill.name, content);
    return { name: skill.name, baseDir: skill.baseDir, content };
  }

  get askUser(): RuntimeHandle['askUser'] {
    return this.ui.askUser ? (q, s) => this.ui.askUser!(q, s) : undefined;
  }

  get approvePlan(): RuntimeHandle['approvePlan'] {
    if (!this.ui.approvePlan) return undefined;
    return async (plan, signal) => {
      const res = await this.ui.approvePlan!(plan, signal);
      if (res.approved) {
        this.permissions.mode = res.mode ?? 'default';
        this.approvedPlan = plan;
      }
      return res;
    };
  }

  todosChanged(): void {
    this.ui.todosChanged?.();
  }

  async runSubagent(req: SubagentRequest): Promise<SubagentResult> {
    const def = findAgent(this.agentDefs, req.type ?? 'general-purpose') ?? findAgent(this.agentDefs, 'general-purpose')!;
    let client = this.client;
    if (def.model && def.model !== client.model) {
      try {
        client = new ModelClient(this.provider, def.model, await profileModel(this.provider, def.model, this.settings), this.settings);
      } catch {
        client = this.client; // fall back to the session model
      }
    }
    // Start from everything the session has (not the main agent's subset), then apply this agent's own limits.
    const tools = withoutTools(
      filterTools(
        this.sessionTools().filter((t) => !SUBAGENT_EXCLUDED.has(t.name)),
        def.tools,
      ),
      def.disallowedTools,
    );
    // Skills named in the agent file are loaded up front: the subagent starts with their instructions.
    const preloaded: string[] = [];
    for (const name of def.skills ?? []) {
      const skill = this.skillDefs.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!skill) continue;
      const body = await expandSkill(skill, '', { sessionId: this.session.id, projectDir: this.session.projectRoot });
      preloaded.push(renderSkill(skill.name, skill.baseDir, body));
    }
    let startContext = '';
    if (this.hooks.has('SubagentStart')) {
      const started = await this.hooks.run('SubagentStart', { agent_type: def.name }, def.name, req.signal);
      startContext = started.additionalContext ?? '';
    }
    const system = [buildSubagentPrompt(def.prompt, { ...this.env, cwd: this.session.cwd }, def.omitMemory ? '' : this.memoryText), ...preloaded, startContext]
      .filter(Boolean)
      .join('\n\n');
    const agent = new Agent({
      client,
      tools: () => tools,
      system: () => system,
      session: this.session,
      permissions: this.permissions,
      hooks: this.hooks,
      runtime: this,
      settings: this.settings,
      depth: req.depth,
      requestPermission: this.ui.requestPermission ? (p) => this.ui.requestPermission!(p) : undefined,
      maxTurns: def.maxTurns ?? 60,
    });

    let toolUses = 0;
    let tokens = 0;
    let error: string | undefined;
    const activity: string[] = [];
    for await (const ev of agent.run(req.prompt, req.signal)) {
      if (ev.type === 'tool_start') {
        toolUses++;
        activity.push(`${ev.call.name}${ev.label ? `(${ev.label})` : ''}`);
        req.onProgress?.(activity.slice(-4).join('\n'));
      } else if (ev.type === 'usage') {
        tokens = Math.max(tokens, ev.usage.inputTokens + ev.usage.outputTokens);
      } else if (ev.type === 'done' && ev.reason === 'error') {
        error = ev.error;
      }
    }
    // Fold the subagent's usage into the session totals.
    this.agent.totals.inputTokens += agent.totals.inputTokens;
    this.agent.totals.outputTokens += agent.totals.outputTokens;
    this.agent.totals.requests += agent.totals.requests;
    this.agent.totals.evalMs += agent.totals.evalMs;
    const text = agent.lastAssistantText();
    if (error) return { text: `The subagent failed: ${error}${text ? `\n\nPartial output:\n${text}` : ''}`, toolUses, tokens, isError: true };
    return { text, toolUses, tokens };
  }

  /** A ToolContext for running tools outside the agent loop (bash mode, command expansion). */
  toolContext(signal: AbortSignal): ToolContext {
    const session = this.session;
    return {
      get cwd() {
        return session.cwd;
      },
      signal,
      settings: this.settings,
      session,
      toolCallId: 'direct',
      depth: 0,
      runtime: this,
    };
  }
}

/** Resolve a requested model name against what the server lists. */
export function matchModel(requested: string, available: ModelInfo[]): string | undefined {
  const ids = available.map((m) => m.id);
  if (ids.includes(requested)) return requested;
  // Ollama: "qwen3" means "qwen3:latest".
  if (!requested.includes(':') && ids.includes(`${requested}:latest`)) return `${requested}:latest`;
  const lower = requested.toLowerCase();
  return ids.find((id) => id.toLowerCase() === lower);
}
