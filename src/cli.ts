import * as fs from 'node:fs';
import * as path from 'node:path';
import { doctorReport } from './commands/builtin.ts';
import { Controller, type ControllerOptions } from './core/controller.ts';
import { displayPath } from './config/paths.ts';
import type { Settings, SettingsScope } from './config/settings.ts';
import { getByPath, loadSettings, parseSettingValue, setByPath, settingsPath, updateSettingsFile } from './config/settings.ts';
import type { McpScope, McpServerConfig } from './mcp/config.ts';
import { addMcpServer, loadMcpServers, mcpConfigPath, removeMcpServer } from './mcp/config.ts';
import { NO_SERVER_HELP, ProviderError, detectServers, rankModels } from './providers/index.ts';
import { findSession, listSessions } from './session/store.ts';
import { enableDebug } from './util/debug.ts';
import { PERMISSION_MODES, type ImagePart, type PermissionMode } from './types.ts';
import { c, formatBytes, formatCount, formatDuration, padEnd, plural, setColorEnabled } from './ui/ansi.ts';
import type { OutputFormat } from './ui/print.ts';
import { APP_NAME, VERSION } from './version.ts';

const HELP = `${APP_NAME} ${VERSION} - a coding agent for local models

Usage:
  ${APP_NAME} [options] [prompt]        start an interactive session
  ${APP_NAME} -p [options] <prompt>     run one prompt and print the result
  cat file | ${APP_NAME} -p "explain"   piped input is added to the prompt

Options:
  -p, --print                      Run non-interactively and exit
  -c, --continue                   Continue the most recent conversation in this directory
  -r, --resume [id]                Resume a conversation by id, or pick one
  -m, --model <name>               Model to use (also: provider/model)
      --provider <name>            ollama, lmstudio, llamacpp, vllm, jan, openai, or one from settings
      --base-url <url>             Any OpenAI-compatible endpoint, e.g. http://localhost:8080/v1
      --api-key <key>              API key for that endpoint, if it needs one
      --context <tokens>           Context window to use (default: detected, up to 32768)
      --max-output-tokens <n>      Output limit per response
      --tool-mode <mode>           auto, native or prompt (text tool protocol)
      --permission-mode <mode>     ${PERMISSION_MODES.join(', ')}
      --dangerously-skip-permissions   Never ask for approval (use only in a sandbox)
      --allowedTools <rules...>    Rules to allow, e.g. "Bash(npm test:*)" Edit
                                   (list flags take every following word: put the prompt first, or after --)
      --disallowedTools <rules...> Rules to deny, e.g. "Bash(rm:*)" WebFetch
      --tools <names...>           Limit the tools available to the model
      --add-dir <dirs...>          Extra directories the agent may work in
      --system-prompt <text>       Replace the built-in system prompt
      --system-prompt-file <file>  Same, read from a file
      --append-system-prompt <text>    Add to the system prompt
      --append-system-prompt-file <file>   Same, read from a file
      --fallback-model <names>     Models to try, in order, when the main model fails (comma-separated)
      --effort <level>             Reasoning level for models that take one (low, medium, high) or on/off
  -n, --name <name>                Name the session so it can be resumed by name
      --session-id <uuid>          Use a specific session id
      --fork-session               With --resume/--continue: continue in a new session, leaving the original as it is
      --strict-mcp-config          Use only the MCP servers given with --mcp-config
      --bare                       Ignore memory files, hooks, MCP servers, skills, commands and custom agents
      --disable-slash-commands     Treat input starting with / as plain text
      --include-partial-messages   With stream-json: also emit text as it streams
      --debug [categories]         Log requests, responses and tool calls to stderr (api, tools)
      --debug-file <path>          Write that log to a file instead
      --output-format <fmt>        With -p: text (default), json or stream-json
      --max-turns <n>              With -p: stop after n model turns
      --image <files...>           With -p: attach images (vision models only)
      --mcp-config <files...>      Extra MCP server definitions (JSON files or strings)
      --settings <file|json>       Extra settings to load
      --no-session-persistence     Do not save a transcript
      --verbose                    Show full tool output
      --no-color                   Disable colours
  -v, --version                    Print the version
  -h, --help                       Show this help

Commands:
  ${APP_NAME} models                    List models on running local servers
  ${APP_NAME} doctor                    Check the setup
  ${APP_NAME} sessions                  List saved conversations for this directory
  ${APP_NAME} config [get|set|list]     Read or change settings
  ${APP_NAME} mcp [add|list|get|remove] Manage MCP servers

Environment:
  COCO_MODEL, COCO_PROVIDER, COCO_BASE_URL, COCO_API_KEY, COCO_CONTEXT_WINDOW,
  COCO_CONFIG_DIR, OLLAMA_HOST, OPENAI_BASE_URL, OPENAI_API_KEY
`;

interface ParsedArgs {
  flags: Record<string, string | boolean | string[]>;
  positional: string[];
}

/** Flags that take one value, several values, or none. */
const VALUE_FLAGS = new Set([
  'model', 'provider', 'base-url', 'api-key', 'context', 'max-output-tokens', 'tool-mode', 'permission-mode',
  'system-prompt', 'system-prompt-file', 'append-system-prompt', 'output-format', 'max-turns', 'settings',
  'scope', 'transport', 'input-format', 'append-system-prompt-file', 'session-id', 'name', 'effort', 'fallback-model',
  'debug-file',
]);
const LIST_FLAGS = new Set(['allowedTools', 'allowed-tools', 'disallowedTools', 'disallowed-tools', 'tools', 'add-dir', 'mcp-config', 'env', 'header', 'image']);
const OPTIONAL_VALUE_FLAGS = new Set(['resume']);
const SHORT: Record<string, string> = { p: 'print', c: 'continue', r: 'resume', m: 'model', v: 'version', h: 'help', s: 'scope', e: 'env', t: 'transport', H: 'header', n: 'name' };

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: ParsedArgs['flags'] = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    let name: string;
    let inline: string | undefined;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    } else {
      name = SHORT[arg.slice(1)] ?? arg.slice(1);
    }
    if (LIST_FLAGS.has(name)) {
      const values: string[] = inline !== undefined ? [inline] : [];
      // Path lists stop at the first argument that is not a path, so a prompt after them is not swallowed.
      const wantsPath = name === 'add-dir' || name === 'image';
      while (inline === undefined && i + 1 < argv.length && !argv[i + 1]!.startsWith('-')) {
        if (wantsPath && values.length > 0 && !fs.existsSync(argv[i + 1]!)) break;
        values.push(argv[++i]!);
      }
      // "a,b c" and separate arguments are both accepted.
      const split = name === 'env' || name === 'header' || name === 'mcp-config' || name === 'image' || name === 'add-dir' ? values : values.flatMap(splitRules);
      flags[name] = [...((flags[name] as string[] | undefined) ?? []), ...split];
    } else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Error(`--${name} needs a value.`);
      flags[name] = value;
    } else if (OPTIONAL_VALUE_FLAGS.has(name)) {
      if (inline !== undefined) flags[name] = inline;
      // Only something shaped like a session id is taken as one; anything else is the prompt.
      // (A session name is given with an equals sign: --resume=my-feature.)
      else if (i + 1 < argv.length && /^[0-9a-f]{8}(-[0-9a-f-]*)?$/i.test(argv[i + 1]!)) flags[name] = argv[++i]!;
      else flags[name] = true;
    } else {
      flags[name] = inline ?? true;
    }
  }
  return { flags, positional };
}

/** Split "Bash(git log:*), Edit" on commas and spaces that are outside parentheses. */
export function splitRules(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ' ') && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function list(flags: ParsedArgs['flags'], ...names: string[]): string[] | undefined {
  const values = names.flatMap((n) => (flags[n] as string[] | undefined) ?? []);
  return values.length ? values : undefined;
}

function str(flags: ParsedArgs['flags'], name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function settingsFromFlags(flags: ParsedArgs['flags']): Settings {
  const s: Settings = {};
  if (str(flags, 'model')) s.model = str(flags, 'model');
  if (str(flags, 'provider')) s.provider = str(flags, 'provider');
  if (str(flags, 'base-url')) s.baseUrl = str(flags, 'base-url');
  if (str(flags, 'api-key')) s.apiKey = str(flags, 'api-key');
  const context = Number(str(flags, 'context'));
  if (str(flags, 'context')) {
    if (!(context >= 1024)) fail('--context must be a number of tokens (at least 1024).');
    s.contextWindow = context;
  }
  const maxOut = Number(str(flags, 'max-output-tokens'));
  if (str(flags, 'max-output-tokens')) {
    if (!(maxOut > 0)) fail('--max-output-tokens must be a positive number.');
    s.maxOutputTokens = maxOut;
  }
  const toolMode = str(flags, 'tool-mode');
  if (toolMode) {
    if (toolMode !== 'auto' && toolMode !== 'native' && toolMode !== 'prompt') fail('--tool-mode must be auto, native or prompt.');
    s.toolMode = toolMode;
  }
  let mode = str(flags, 'permission-mode') as PermissionMode | undefined;
  if ((mode as string) === 'manual') mode = 'default'; // Claude Code's name for the default mode
  if (mode && !PERMISSION_MODES.includes(mode)) fail(`--permission-mode must be one of: ${PERMISSION_MODES.join(', ')}.`);
  const effort = str(flags, 'effort');
  if (effort) s.thinking = effort === 'on' ? true : effort === 'off' || effort === 'none' ? false : effort;
  const fallback = str(flags, 'fallback-model');
  if (fallback) s.fallbackModel = fallback.split(',').map((m) => m.trim()).filter(Boolean);
  if (flags['dangerously-skip-permissions']) mode = 'bypassPermissions';
  if (mode) s.permissions = { defaultMode: mode };
  if (flags.verbose) s.verbose = true;
  return s;
}

// ---------------------------------------------------------------- subcommands

async function cmdModels(): Promise<number> {
  const { merged } = loadSettings({ projectRoot: process.cwd() });
  const servers = await detectServers(merged, 1500);
  if (servers.length === 0) {
    process.stdout.write(`${NO_SERVER_HELP}\n`);
    return 1;
  }
  for (const server of servers) {
    process.stdout.write(`${c.bold(server.name)} ${c.dim(server.config.baseUrl)}\n`);
    const models = rankModels(server.models);
    if (models.length === 0) process.stdout.write(c.dim('  (no chat models)\n'));
    for (const m of models) {
      const details = [m.parameterSize, m.quantization, m.sizeBytes ? formatBytes(m.sizeBytes) : '', m.contextLength ? `${formatCount(m.contextLength)} ctx` : '', m.loaded ? c.green('loaded') : '']
        .filter(Boolean)
        .join(' · ');
      process.stdout.write(`  ${padEnd(m.id, 42)} ${c.dim(details)}\n`);
    }
  }
  process.stdout.write(c.dim(`\nUse one with: ${APP_NAME} --model <name>\n`));
  return 0;
}

function cmdSessions(): number {
  const sessions = listSessions(process.cwd(), 30);
  if (sessions.length === 0) {
    process.stdout.write('No saved conversations for this directory.\n');
    return 0;
  }
  for (const s of sessions) {
    const label = s.title ? `${c.bold(s.title)} ${c.dim('·')} ${s.firstPrompt.slice(0, 50)}` : s.firstPrompt.slice(0, 70);
    process.stdout.write(`${c.cyan(s.id)}  ${c.dim(padEnd(`${formatDuration(Date.now() - s.modifiedAt.getTime())} ago`, 12))} ${label}\n`);
  }
  process.stdout.write(c.dim(`\nResume one with: ${APP_NAME} --resume <id>\n`));
  return 0;
}

function parseScope(value: string | undefined, fallback: SettingsScope): SettingsScope {
  if (!value) return fallback;
  if (value === 'user' || value === 'project' || value === 'local') return value;
  return fail('--scope must be user, project or local.');
}

function cmdConfig(args: ParsedArgs): number {
  const [verb, key, ...rest] = args.positional;
  const cwd = process.cwd();
  if (verb === 'set') {
    if (!key || rest.length === 0) fail(`Usage: ${APP_NAME} config set <key> <value> [--scope user|project|local]`);
    const scope = parseScope(str(args.flags, 'scope'), 'user');
    const value = parseSettingValue(rest.join(' '));
    let file: string;
    try {
      file = updateSettingsFile(scope, cwd, (s) => setByPath(s as Record<string, unknown>, key!, value));
    } catch (err) {
      return fail(`Could not set ${key}: ${(err as Error).message}`);
    }
    process.stdout.write(`Set ${key} = ${JSON.stringify(value)} in ${file}\n`);
    return 0;
  }
  if (verb === 'unset') {
    if (!key) fail(`Usage: ${APP_NAME} config unset <key> [--scope user|project|local]`);
    const scope = parseScope(str(args.flags, 'scope'), 'user');
    let file: string;
    try {
      file = updateSettingsFile(scope, cwd, (s) => setByPath(s as Record<string, unknown>, key!, undefined));
    } catch (err) {
      return fail(`Could not unset ${key}: ${(err as Error).message}`);
    }
    process.stdout.write(`Removed ${key} from ${file}\n`);
    return 0;
  }
  const loaded = loadSettings({ projectRoot: cwd });
  if (verb === 'get') {
    if (!key) fail(`Usage: ${APP_NAME} config get <key>`);
    const value = getByPath(loaded.merged, key!);
    process.stdout.write(`${value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
    return value === undefined ? 1 : 0;
  }
  process.stdout.write(`${JSON.stringify(loaded.merged, null, 2)}\n\n`);
  for (const scope of ['user', 'project', 'local'] as const) {
    const file = settingsPath(scope, cwd);
    process.stdout.write(c.dim(`${padEnd(scope, 8)} ${file}${fs.existsSync(file) ? '' : ' (not created)'}\n`));
  }
  for (const e of loaded.errors) process.stderr.write(`${c.red(e)}\n`);
  return 0;
}

async function cmdMcp(args: ParsedArgs): Promise<number> {
  const [verb, name, ...rest] = args.positional;
  const cwd = process.cwd();
  if (verb === 'add') {
    if (!name) fail(`Usage: ${APP_NAME} mcp add <name> [--scope user|project|local] [-e KEY=value] -- <command> [args...]\n       ${APP_NAME} mcp add --transport http <name> <url> [-H "Header: value"]`);
    const scope = parseScope(str(args.flags, 'scope'), 'local') as McpScope;
    const transport = str(args.flags, 'transport') ?? (/^https?:\/\//.test(rest[0] ?? '') ? 'http' : 'stdio');
    let config: McpServerConfig;
    if (transport === 'http' || transport === 'sse') {
      if (!rest[0]) fail('A URL is required for http and sse servers.');
      const headers: Record<string, string> = {};
      for (const h of list(args.flags, 'header') ?? []) {
        const idx = h.indexOf(':');
        if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
      }
      config = { type: transport, url: rest[0]!, ...(Object.keys(headers).length ? { headers } : {}) };
    } else {
      if (!rest[0]) fail('A command is required. Put it after "--", for example: coco mcp add files -- npx -y @modelcontextprotocol/server-filesystem .');
      const env: Record<string, string> = {};
      for (const e of list(args.flags, 'env') ?? []) {
        const idx = e.indexOf('=');
        if (idx > 0) env[e.slice(0, idx)] = e.slice(idx + 1);
      }
      config = { command: rest[0]!, args: rest.slice(1), ...(Object.keys(env).length ? { env } : {}) };
    }
    const file = addMcpServer(scope, cwd, name!, config);
    process.stdout.write(`Added MCP server "${name}" (${scope}) to ${file}\n`);
    return 0;
  }
  if (verb === 'remove' || verb === 'rm') {
    if (!name) fail(`Usage: ${APP_NAME} mcp remove <name> [--scope user|project|local]`);
    const scope = str(args.flags, 'scope') ? (parseScope(str(args.flags, 'scope'), 'local') as McpScope) : undefined;
    const removed = removeMcpServer(cwd, name!, scope);
    process.stdout.write(removed ? `Removed MCP server "${name}" (${removed}).\n` : `No MCP server named "${name}".\n`);
    return removed ? 0 : 1;
  }
  const { merged } = loadSettings({ projectRoot: cwd });
  const { servers, errors } = loadMcpServers(cwd, { inline: merged.mcpServers, disabled: merged.disabledMcpServers });
  for (const e of errors) process.stderr.write(`${c.yellow(e)}\n`);
  if (verb === 'get') {
    const server = servers.find((s) => s.name === name);
    if (!server) fail(`No MCP server named "${name}".`);
    process.stdout.write(`${JSON.stringify({ name: server!.name, scope: server!.scope, ...server!.config }, null, 2)}\n`);
    return 0;
  }
  if (servers.length === 0) {
    process.stdout.write(`No MCP servers configured.\nAdd one with: ${APP_NAME} mcp add <name> -- <command> [args...]\n`);
    for (const scope of ['user', 'project', 'local'] as const) process.stdout.write(c.dim(`${padEnd(scope, 8)} ${mcpConfigPath(scope, cwd)}\n`));
    return 0;
  }
  for (const s of servers) {
    const target = 'url' in s.config ? `${s.config.type} ${s.config.url}` : `${s.config.command} ${(s.config.args ?? []).join(' ')}`;
    process.stdout.write(`${padEnd(s.name, 20)} ${c.dim(padEnd(s.scope, 9))} ${target}\n`);
  }
  return 0;
}

function loadImages(files: string[]): ImagePart[] {
  const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  return files.map((f) => {
    const type = types[path.extname(f).toLowerCase()];
    if (!type) fail(`Unsupported image type: ${f}`);
    return { type: 'image' as const, mediaType: type!, data: fs.readFileSync(f).toString('base64') };
  });
}

// ------------------------------------------------------------------------ main

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return fail((err as Error).message);
  }
  const { flags, positional } = args;
  if (flags['no-color']) setColorEnabled(false);
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const sub = positional[0];
  if (sub === 'models') return cmdModels();
  if (sub === 'sessions') return cmdSessions();
  if (sub === 'config') return cmdConfig({ flags, positional: positional.slice(1) });
  if (sub === 'mcp') return cmdMcp({ flags, positional: positional.slice(1) });

  const headless = Boolean(flags.print) || sub === 'doctor';
  const piped = !process.stdin.isTTY;
  const interactive = !headless && process.stdin.isTTY && process.stdout.isTTY;

  let systemPrompt = str(flags, 'system-prompt');
  const promptFile = str(flags, 'system-prompt-file');
  if (promptFile) {
    try {
      systemPrompt = fs.readFileSync(promptFile, 'utf8');
    } catch (err) {
      return fail(`Could not read --system-prompt-file: ${(err as Error).message}`);
    }
  }
  const maxTurns = str(flags, 'max-turns') ? Number(str(flags, 'max-turns')) : undefined;
  if (maxTurns !== undefined && !(maxTurns > 0)) return fail('--max-turns must be a positive number.');

  let appendSystemPrompt = str(flags, 'append-system-prompt');
  const appendFile = str(flags, 'append-system-prompt-file');
  if (appendFile) {
    try {
      appendSystemPrompt = [appendSystemPrompt, fs.readFileSync(appendFile, 'utf8')].filter(Boolean).join('\n\n');
    } catch (err) {
      return fail(`Could not read --append-system-prompt-file: ${(err as Error).message}`);
    }
  }
  const sessionId = str(flags, 'session-id');
  if (sessionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return fail('--session-id must be a UUID, for example 123e4567-e89b-12d3-a456-426614174000.');
  }
  if (flags.debug || str(flags, 'debug-file')) {
    const file = enableDebug(str(flags, 'debug-file'), typeof flags.debug === 'string' ? flags.debug : undefined);
    if (file) process.stderr.write(c.dim(`Debug log: ${file}\n`));
  }

  const options: ControllerOptions = {
    cwd: process.cwd(),
    overrides: settingsFromFlags(flags),
    extraSettings: str(flags, 'settings'),
    allowedTools: list(flags, 'allowedTools', 'allowed-tools'),
    disallowedTools: list(flags, 'disallowedTools', 'disallowed-tools'),
    toolFilter: list(flags, 'tools'),
    addDirs: list(flags, 'add-dir'),
    mcpConfigFiles: list(flags, 'mcp-config'),
    systemPrompt,
    appendSystemPrompt,
    maxTurns,
    persist: !flags['no-session-persistence'],
    interactive,
    sessionId,
    sessionName: str(flags, 'name'),
    bare: Boolean(flags.bare || flags['safe-mode']),
    strictMcp: Boolean(flags['strict-mcp-config']),
  };

  let ctl: Controller;
  try {
    ctl = new Controller(options);
  } catch (err) {
    return fail((err as Error).message);
  }

  // Work out which earlier session, if any, to load.
  let resumed = false;
  const fork = Boolean(flags['fork-session']);
  const resumeFlag = flags.resume;
  if (typeof resumeFlag === 'string') {
    const found = findSession(ctl.session.projectRoot, resumeFlag);
    if (!found) return fail(`No session matching "${resumeFlag}" in this directory. Run "${APP_NAME} sessions" to list them.`);
    ctl.resume(found, { fork });
    resumed = true;
  } else if (flags.continue || (resumeFlag === true && !interactive)) {
    const latest = listSessions(ctl.session.projectRoot, 1)[0];
    if (latest) {
      ctl.resume(latest, { fork });
      resumed = true;
    } else if (flags.continue) {
      process.stderr.write(c.dim('No earlier conversation here; starting a new one.\n'));
    }
  }

  if (sub === 'doctor') {
    try {
      await ctl.connect();
      await ctl.connectMcp();
    } catch (err) {
      process.stdout.write(`${c.bold(`${APP_NAME} doctor`)}\n  ${c.red('✗')} ${(err as Error).message.split('\n').join('\n    ')}\n`);
      return 1;
    }
    process.stdout.write(`${(await doctorReport(ctl)).join('\n')}\n`);
    await ctl.shutdown();
    return 0;
  }

  const promptArg = positional.join(' ').trim();

  if (!interactive) {
    const stdinText = piped ? (await readStdin()).trim() : '';
    let prompt = promptArg;
    if (stdinText) prompt = prompt ? `${prompt}\n\n<stdin>\n${stdinText}\n</stdin>` : stdinText;
    if (!prompt) return fail(`No prompt given. Usage: ${APP_NAME} -p "your prompt"   (or run ${APP_NAME} in a terminal for an interactive session)`);
    const format = (str(flags, 'output-format') ?? 'text') as OutputFormat;
    if (!['text', 'json', 'stream-json'].includes(format)) return fail('--output-format must be text, json or stream-json.');
    if (format !== 'text') setColorEnabled(false);
    try {
      await ctl.connect();
    } catch (err) {
      return fail(err instanceof ProviderError ? err.message : `Could not start: ${(err as Error).message}`);
    }
    for (const e of ctl.loaded.errors) process.stderr.write(`${c.red(`Settings error: ${e}`)}\n`);
    for (const note of ctl.client.profile.notes) process.stderr.write(`${c.yellow(`! ${note}`)}\n`);
    await ctl.connectMcp();
    for (const s of (ctl.mcp?.status() ?? []).filter((x) => x.status === 'failed')) process.stderr.write(`${c.yellow(`MCP server "${s.name}" failed: ${s.error ?? ''}`)}\n`);
    await ctl.runSessionHook('SessionStart', { source: resumed ? 'resume' : 'startup' }, resumed ? 'resume' : 'startup');
    const { runPrint } = await import('./ui/print.ts');
    const images = list(flags, 'image') ?? [];
    const code = await runPrint(ctl, {
      prompt,
      format,
      verbose: Boolean(flags.verbose),
      images: images.length ? loadImages(images) : undefined,
      includePartial: Boolean(flags['include-partial-messages']),
      disableSlashCommands: Boolean(flags['disable-slash-commands']),
    });
    await ctl.shutdown();
    return code;
  }

  const { App } = await import('./ui/app.ts');
  const app = new App(ctl);
  let showHistory = resumed;
  if (resumeFlag === true && !resumed) {
    // `--resume` with no id: the picker opens once the UI is up.
    return app.run({ initialPrompt: '/resume', showHistory: false });
  }
  if (resumed && promptArg === '') showHistory = true;
  return app.run({ initialPrompt: promptArg || undefined, showHistory });
}

export { displayPath, plural };
