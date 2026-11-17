/**
 * The interactive terminal UI. Finished output goes to the terminal's own
 * scrollback; a redrawn region at the bottom holds streaming text, running
 * tools, the spinner, the prompt and any dialog.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentEvent, PermissionAnswer, PermissionPrompt } from '../agent/loop.ts';
import type { CommandIO, ResolvedCommand, SelectOption } from '../commands/builtin.ts';
import { allCommands, runSlash, saveMemoryNote } from '../commands/builtin.ts';
import { configDir, displayPath } from '../config/paths.ts';
import type { Controller } from '../core/controller.ts';
import type { Suggestion } from '../permissions/manager.ts';
import { MODE_CYCLE, modeLabel } from '../permissions/manager.ts';
import type { ModelInfo } from '../providers/index.ts';
import { listProjectFiles } from '../tools/search.ts';
import { commandEnv, runCommand, shellPath } from '../tools/shell.ts';
import type { AskQuestion, ToolResult } from '../tools/types.ts';
import type { PermissionMode } from '../types.ts';
import { messageText } from '../types.ts';
import { diffLines, renderDiff } from '../util/diff.ts';
import { APP_NAME, VERSION } from '../version.ts';
import { c, formatBytes, formatContext, formatCount, formatDuration, padEnd, stringWidth, truncate, wrapText } from './ansi.ts';
import type { Dialog, DialogOption, SelectResult } from './dialog.ts';
import { SelectDialog } from './dialog.ts';
import { Editor } from './editor.ts';
import type { Key } from './keys.ts';
import { KeyParser } from './keys.ts';
import { MarkdownStream, renderMarkdown } from './markdown.ts';
import { BULLET, renderHistory, renderTodos, renderToolResult, renderUserPrompt, toolHeader, withBullet } from './render.ts';
import { Screen } from './screen.ts';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';
const MAX_COMPLETIONS = 8;

interface ToolRun {
  name: string;
  label: string;
  startedAt: number;
  progress: string;
}

interface Completion {
  kind: 'command' | 'file';
  start: number;
  items: { value: string; label: string; hint?: string }[];
  index: number;
}

export interface InteractiveOptions {
  initialPrompt?: string;
  /** Print earlier messages (after --continue / --resume). */
  showHistory?: boolean;
}

export class App implements CommandIO {
  private readonly ctl: Controller;
  private readonly screen: Screen;
  private readonly editor = new Editor();
  private readonly parser = new KeyParser();
  private dialog: Dialog | null = null;
  private completion: Completion | null = null;
  private completionDismissed = '';
  private files: string[] | null = null;
  private filesLoading = false;

  private running = false;
  private phase: 'thinking' | 'responding' | 'tools' | 'compacting' = 'thinking';
  private turnStart = 0;
  private turnOutputTokens = 0;
  private streamChars = 0;
  private lastSpeed = 0;
  private spinnerFrame = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private md: MarkdownStream | null = null;
  private mdPrinted = false;
  private thinking = '';
  private thinkingStart = 0;
  private toolRuns = new Map<string, ToolRun>();
  private toolLabels = new Map<string, { name: string; label: string }>();

  private verbose: boolean;
  private notice = '';
  private noticeTimer: NodeJS.Timeout | null = null;
  private lastEscape = 0;
  private lastCtrlC = 0;
  private statusLine = '';
  private escTimer: NodeJS.Timeout | null = null;
  private exitResolve: ((code: number) => void) | null = null;
  private exiting = false;
  /** Resolves once the model is connected; prompts typed earlier wait for it. */
  private ready: Promise<void>;
  private markReady: () => void = () => {};
  private readonly historyFile: string;

  constructor(ctl: Controller) {
    this.ctl = ctl;
    this.screen = new Screen(process.stdout);
    this.verbose = Boolean(ctl.settings.verbose);
    this.historyFile = path.join(configDir(), 'history.jsonl');
    this.ready = new Promise((resolve) => (this.markReady = resolve));
  }

  // --------------------------------------------------------------- CommandIO

  print(text: string): void {
    this.screen.print(text.split('\n'));
  }

  width(): number {
    return this.screen.width;
  }

  select<T>(spec: { question: string; options: SelectOption<T>[]; filterable?: boolean; header?: string[] }): Promise<T | undefined> {
    return this.openSelect<T>({ ...spec, options: spec.options }).then((r) => r?.value);
  }

  private openSelect<T>(spec: {
    question?: string;
    header?: string[];
    options: DialogOption<T>[];
    filterable?: boolean;
    multi?: boolean;
    footer?: string;
  }): Promise<SelectResult<T> | null> {
    return new Promise((resolve) => {
      // Only one dialog at a time; a new one replaces (and cancels) the old.
      this.dialog?.cancel();
      this.dialog = new SelectDialog<T>(spec, (result) => {
        this.dialog = null;
        resolve(result);
        this.draw();
      });
      this.draw();
    });
  }

  async editFile(file: string): Promise<void> {
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
    this.screen.suspend();
    this.setRaw(false);
    await new Promise<void>((resolve) => {
      const { shell, args } = shellPath();
      const child = spawn(shell, args(`${editor} ${JSON.stringify(file)}`), { stdio: 'inherit', env: commandEnv() });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });
    this.setRaw(true);
    this.screen.resume();
    this.draw();
  }

  clearScreen(): void {
    this.screen.clearAll();
  }

  exit(): void {
    void this.quit(0);
  }

  showHistory(): void {
    const lines = renderHistory(this.ctl.agent.messages, this.screen.width);
    if (lines.length) this.screen.print(lines);
  }

  toggleVerbose(): boolean {
    this.verbose = !this.verbose;
    return this.verbose;
  }

  setInput(text: string): void {
    this.editor.set(text);
    this.draw();
  }

  // ------------------------------------------------------------------ startup

  private setRaw(on: boolean): void {
    if (process.stdin.isTTY) process.stdin.setRawMode(on);
    process.stdout.write(on ? BRACKETED_PASTE_ON : BRACKETED_PASTE_OFF);
  }

  async run(opts: InteractiveOptions = {}): Promise<number> {
    const done = new Promise<number>((resolve) => (this.exitResolve = resolve));
    this.setRaw(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => this.onData(chunk));
    process.stdin.resume();
    process.stdout.on('resize', () => this.draw());
    process.on('SIGTERM', () => void this.quit(143));
    process.on('SIGHUP', () => void this.quit(129));
    // A stray error must not leave the terminal in raw mode with a dead UI.
    const report = (err: unknown) => {
      if (this.exiting) return;
      this.print(c.red(`Internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
      this.draw();
    };
    process.on('uncaughtException', report);
    process.on('unhandledRejection', report);

    this.ctl.attachUi({
      requestPermission: (p) => this.askPermission(p),
      askUser: (q, signal) => this.askQuestions(q, signal),
      approvePlan: (plan, signal) => this.approvePlan(plan, signal),
      todosChanged: () => this.draw(),
    });
    this.loadHistory();
    this.draw();

    try {
      await this.startup(opts);
    } catch (err) {
      this.print(c.red((err as Error).message));
      await this.quit(1);
    }
    return done;
  }

  private async startup(opts: InteractiveOptions): Promise<void> {
    const ctl = this.ctl;
    if (ctl.projectRunsCode() && !ctl.isTrusted()) {
      const answer = await this.select<boolean>({
        question: `Trust the files in ${ctl.session.projectRoot}?`,
        header: wrapText(
          'This project defines hooks, MCP servers or a status line command. Those run programs on your machine, so only enable them for code you trust.',
          this.screen.width,
          { indent: ' ' },
        ).map((l) => c.yellow(l)),
        options: [
          { label: 'Yes, trust this project', value: true, hint: 'remembered for this folder' },
          { label: 'No, continue without them', value: false, hint: 'hooks and project MCP servers stay off' },
        ],
      });
      if (answer) ctl.trustProject();
      else ctl.distrustProject();
    }

    this.setNotice('Connecting to the model server…', 0);
    await ctl.connect((models) => this.pickModel(models));
    if (this.modelWasPicked) {
      try {
        ctl.saveModelChoice();
      } catch {
        // a read-only config directory just means being asked again next time
      }
    }
    this.setNotice('');
    ctl.attachUi(ctl.ui);
    ctl.startupMaintenance();

    this.banner();
    for (const e of ctl.loaded.errors) this.print(c.red(`Settings error: ${e}`));
    if (opts.showHistory) this.showHistory();

    // MCP servers connect in the background; their tools appear when ready.
    void ctl.connectMcp().then(() => {
      const failed = (ctl.mcp?.status() ?? []).filter((s) => s.status === 'failed');
      for (const s of failed) this.print(c.yellow(`MCP server "${s.name}" failed to connect: ${s.error ?? 'unknown error'} (see /mcp)`));
      for (const e of ctl.mcpErrors) this.print(c.yellow(`MCP config: ${e}`));
      this.draw();
    });
    for (const m of await ctl.runSessionHook('SessionStart', { source: opts.showHistory ? 'resume' : 'startup' }, opts.showHistory ? 'resume' : 'startup')) {
      this.print(c.dim(m));
    }
    void this.refreshStatusLine();
    this.markReady();
    this.draw();
    if (opts.initialPrompt?.trim()) await this.submit(opts.initialPrompt.trim());
  }

  private async pickModel(models: ModelInfo[]): Promise<string | undefined> {
    const picked = await this.select<string>({
      question: 'Which model should coco use?',
      filterable: models.length > 10,
      options: models.map((m) => ({
        label: m.id,
        value: m.id,
        hint: [m.parameterSize, m.quantization, m.sizeBytes ? formatBytes(m.sizeBytes) : '', m.loaded ? 'loaded' : ''].filter(Boolean).join(' · '),
      })),
    });
    // Saved once the connection is up, so the question is asked only once.
    if (picked) this.modelWasPicked = true;
    return picked;
  }

  private banner(): void {
    const ctl = this.ctl;
    const p = ctl.client.profile;
    const width = this.screen.width;
    const dim = (text: string) => wrapText(text, width, { indent: '  ' }).map((l) => c.dim(l));
    const lines = [
      '',
      `${c.cyan('✻')} ${c.bold(APP_NAME)} ${c.dim(`v${VERSION}`)}`,
      ...dim(`${ctl.client.model} · ${ctl.provider.name} · ${formatContext(p.contextWindow)} context${p.toolMode === 'prompt' ? ' · text tool protocol' : ''}`),
      ...dim(ctl.session.cwd),
      ...dim('/help for commands · @ to attach files · shift+tab to change mode'),
    ];
    for (const note of p.notes) lines.push(...wrapText(`! ${note}`, width, { indent: '  ', hangingIndent: '    ' }).map((l) => c.yellow(l)));
    if (ctl.memory.length === 0) lines.push(...dim('Tip: run /init to create a COCO.md with instructions for this project.'));
    lines.push('');
    this.screen.print(lines);
  }

  private async quit(code: number): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.dialog?.cancel();
    this.screen.close();
    process.stdout.write(BRACKETED_PASTE_OFF);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    await this.ctl.shutdown();
    if (this.ctl.agent?.messages.length) {
      process.stdout.write(c.dim(`\nResume this session with: ${APP_NAME} --resume ${this.ctl.session.id}\n`));
    }
    this.exitResolve?.(code);
  }

  // -------------------------------------------------------------------- input

  private onData(chunk: string): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    for (const key of this.parser.feed(chunk)) this.handleKey(key);
    if (this.parser.pending) {
      // A lone ESC is only known to be the Escape key once nothing follows it.
      this.escTimer = setTimeout(() => {
        this.escTimer = null;
        for (const key of this.parser.flush()) this.handleKey(key);
        this.draw();
      }, 40);
    }
    this.draw();
  }

  private setNotice(text: string, ms = 2500): void {
    this.notice = text;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    if (text && ms > 0) {
      this.noticeTimer = setTimeout(() => {
        this.notice = '';
        this.draw();
      }, ms);
    }
    this.draw();
  }

  private handleKey(key: Key): void {
    if (this.exiting) return;
    if (this.dialog) {
      this.dialog.handleKey(key);
      return;
    }

    if (key.ctrl && key.name === 'c') {
      if (this.running) {
        this.interrupt();
        return;
      }
      if (!this.editor.isEmpty) {
        this.editor.clear();
        this.completion = null;
        return;
      }
      if (Date.now() - this.lastCtrlC < 2000) {
        void this.quit(0);
        return;
      }
      this.lastCtrlC = Date.now();
      this.setNotice('Press ctrl+c again to exit', 2000);
      return;
    }
    if (key.ctrl && key.name === 'd') {
      if (this.editor.isEmpty) void this.quit(0);
      else this.editor.del();
      return;
    }
    if (key.name === 'escape') {
      if (this.completion) {
        this.completionDismissed = this.editor.text;
        this.completion = null;
        return;
      }
      if (this.running) {
        this.interrupt();
        return;
      }
      const double = Date.now() - this.lastEscape < 800;
      this.lastEscape = Date.now();
      if (!this.editor.isEmpty) {
        if (double) this.editor.clear();
        else this.setNotice('Press esc again to clear', 800);
      } else if (double) {
        void this.command('/rewind');
      } else if (this.ctl.agent?.messages.length) {
        this.setNotice('Press esc again to rewind', 800);
      }
      return;
    }
    if (key.name === 'tab' && key.shift) {
      const current = MODE_CYCLE.indexOf(this.ctl.permissions.mode);
      this.ctl.setMode(MODE_CYCLE[(current + 1) % MODE_CYCLE.length]!);
      return;
    }
    if (key.ctrl && key.name === 'l') {
      this.screen.clearAll();
      return;
    }
    if (key.ctrl && key.name === 'o') {
      this.verbose = !this.verbose;
      this.setNotice(`Verbose output ${this.verbose ? 'on' : 'off'}`, 1500);
      return;
    }

    if (this.completion) {
      const comp = this.completion;
      if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
        comp.index = (comp.index - 1 + comp.items.length) % comp.items.length;
        return;
      }
      if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
        comp.index = (comp.index + 1) % comp.items.length;
        return;
      }
      if (key.name === 'tab' || (key.name === 'return' && !key.meta && !key.shift)) {
        const item = comp.items[comp.index]!;
        const submitNow = key.name === 'return' && comp.kind === 'command';
        this.editor.replaceRange(comp.start, `${item.value} `);
        this.completion = null;
        this.completionDismissed = this.editor.text;
        if (submitNow) this.enter();
        return;
      }
    }

    const ed = this.editor;
    const inputWidth = Math.max(10, this.screen.width - 2);
    switch (key.name) {
      case 'return':
        if (key.meta || key.shift) ed.insert('\n');
        else if (ed.text.slice(0, ed.cursor).endsWith('\\')) {
          ed.backspace();
          ed.insert('\n');
        } else this.enter();
        break;
      case 'j':
        if (key.ctrl) ed.insert('\n');
        break;
      case 'char':
        if (key.text) ed.insert(key.text);
        break;
      case 'paste':
        if (key.text) ed.paste(key.text);
        break;
      case 'backspace':
        if (key.meta || key.ctrl) ed.killWordBack();
        else ed.backspace();
        break;
      case 'delete':
        ed.del();
        break;
      case 'left':
        if (key.meta || key.ctrl) ed.wordLeft();
        else ed.left();
        break;
      case 'right':
        if (key.meta || key.ctrl) ed.wordRight();
        else ed.right();
        break;
      case 'up':
        if (!ed.up(inputWidth)) ed.historyPrev();
        break;
      case 'down':
        if (!ed.down(inputWidth)) ed.historyNext();
        break;
      case 'home':
        ed.home();
        break;
      case 'end':
        ed.end();
        break;
      case 'a':
        if (key.ctrl) ed.home();
        break;
      case 'e':
        if (key.ctrl) ed.end();
        break;
      case 'b':
        if (key.ctrl) ed.left();
        else if (key.meta) ed.wordLeft();
        break;
      case 'f':
        if (key.ctrl) ed.right();
        else if (key.meta) ed.wordRight();
        break;
      case 'k':
        if (key.ctrl) ed.killToEnd();
        break;
      case 'u':
        if (key.ctrl) ed.killToStart();
        break;
      case 'w':
        if (key.ctrl) ed.killWordBack();
        break;
      case 'y':
        if (key.ctrl) ed.yank();
        break;
      case 'p':
        if (key.ctrl && !ed.up(inputWidth)) ed.historyPrev();
        break;
      case 'n':
        if (key.ctrl && !ed.down(inputWidth)) ed.historyNext();
        break;
      default:
        break;
    }
    this.updateCompletion();
  }

  private updateCompletion(): void {
    const token = this.editor.completionToken();
    if (!token || this.editor.text === this.completionDismissed) {
      this.completion = null;
      return;
    }
    const previous = this.completion?.items[this.completion.index]?.value;
    let items: Completion['items'] = [];
    if (token.kind === 'command') {
      items = rankCommands(allCommands(this.ctl), token.query).map((cmd) => ({
        value: `/${cmd.name}`,
        label: `/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ''}`,
        hint: cmd.description,
      }));
    } else {
      if (!this.files && !this.filesLoading) {
        this.filesLoading = true;
        void listProjectFiles(this.ctl.session.projectRoot).then((files) => {
          this.files = files;
          this.filesLoading = false;
          // The list goes stale as files are created; refresh it now and then.
          setTimeout(() => (this.files = null), 30_000).unref();
          this.updateCompletion();
          this.draw();
        });
      }
      items = rankFiles(this.files ?? [], token.query).map((f) => ({ value: `@${f}`, label: f }));
    }
    if (items.length === 0) {
      this.completion = null;
      return;
    }
    const index = Math.max(0, items.findIndex((i) => i.value === previous));
    this.completion = { kind: token.kind, start: token.start, items, index };
  }

  private enter(): void {
    const text = this.editor.value().trim();
    if (!text) return;
    this.editor.addHistory(this.editor.text.trim());
    // On disk the paste itself is stored: a placeholder would mean nothing in a later session.
    this.appendHistory(text);
    this.editor.clear();
    this.completion = null;
    this.completionDismissed = '';
    void this.submit(text);
  }

  private interrupt(): void {
    this.ctl.abort();
    this.bashAbort?.();
    this.dialog?.cancel();
  }

  // ------------------------------------------------------------------ history

  private loadHistory(): void {
    try {
      const project = this.ctl.session.projectRoot;
      const entries = fs
        .readFileSync(this.historyFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as { project: string; text: string };
          } catch {
            return null;
          }
        })
        .filter((e): e is { project: string; text: string } => e !== null && e.project === project)
        .map((e) => e.text);
      this.editor.setHistory(entries.slice(-300));
    } catch {
      // no history yet
    }
  }

  private appendHistory(text: string): void {
    try {
      fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
      fs.appendFileSync(this.historyFile, JSON.stringify({ project: this.ctl.session.projectRoot, text, ts: Date.now() }) + '\n');
    } catch {
      // history is a convenience
    }
  }

  // ------------------------------------------------------------------- submit

  private async submit(text: string): Promise<void> {
    await this.ready;
    if (this.exiting) return;
    if (this.running) {
      if (text.startsWith('/')) {
        this.setNotice('Commands are unavailable while the model is working (esc to interrupt)', 2500);
        this.editor.set(text);
        return;
      }
      this.ctl.enqueue(text);
      this.draw();
      return;
    }
    if (text.startsWith('/')) {
      await this.command(text);
      return;
    }
    if (text.startsWith('!') && text.length > 1) {
      await this.bashMode(text.slice(1).trim());
      return;
    }
    if (text.startsWith('#') && text.length > 1) {
      await saveMemoryNote(text.slice(1).trim(), this.ctl, this);
      return;
    }
    this.screen.print([...renderUserPrompt(text, this.screen.width), '']);
    await this.runTurn(this.ctl.submit(text));
  }

  private async command(input: string): Promise<void> {
    let outcome: Awaited<ReturnType<typeof runSlash>>;
    // Commands that redraw the screen would only wipe their own echo.
    const redraws = /^\/(clear|reset|new|resume|continue|exit|quit|q)\b/.test(input);
    if (!redraws) this.screen.print([...renderUserPrompt(input, this.screen.width), '']);
    try {
      outcome = await runSlash(input, this.ctl, this);
    } catch (err) {
      this.print(c.red(`Command failed: ${(err as Error).message}`));
      return;
    }
    if (!outcome) {
      this.screen.print('');
      this.draw();
      return;
    }
    if (outcome.type === 'unknown') {
      this.screen.print([c.red(`Unknown command: /${outcome.name}. Type /help to see what is available.`), '']);
      return;
    }
    if (outcome.type === 'compact') {
      await this.runTurn(this.ctl.compact(outcome.instructions));
      return;
    }
    // Rules granted by the command's front matter last for this session.
    for (const rule of outcome.allowedTools ?? []) this.ctl.permissions.addRule('allow', rule);
    await this.runTurn(this.ctl.submit(outcome.prompt, { display: outcome.display }));
  }

  /** `!cmd`: run it directly and show the model what happened. */
  private async bashMode(command: string): Promise<void> {
    this.screen.print(c.magenta(`! ${command}`));
    this.running = true;
    this.phase = 'tools';
    this.turnStart = Date.now();
    this.startSpinner();
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    this.bashAbort = onAbort;
    const res = await runCommand(command, {
      cwd: this.ctl.session.cwd,
      env: this.ctl.settings.env,
      timeoutMs: 600_000,
      signal: abort.signal,
      maxOutput: this.ctl.settings.maxToolOutputChars ?? 30_000,
    });
    this.bashAbort = null;
    this.stopSpinner();
    this.running = false;
    if (res.cwd && fs.existsSync(res.cwd)) this.ctl.session.cwd = res.cwd;
    const output = res.output.replace(/\s+$/, '');
    const shown = output.split('\n');
    const max = this.verbose ? 200 : 30;
    this.screen.print([
      ...shown.slice(0, max).map((l) => `  ${l}`),
      ...(shown.length > max ? [c.dim(`  … +${shown.length - max} lines`)] : []),
      ...(res.exitCode ? [c.red(`  exit code ${res.exitCode}`)] : []),
      '',
    ]);
    const msg = {
      role: 'user' as const,
      isMeta: true,
      content: `The user ran this shell command themselves:\n<bash-input>${command}</bash-input>\n<bash-output>\n${output || '(no output)'}\n</bash-output>${res.exitCode ? `\nExit code ${res.exitCode}` : ''}`,
    };
    this.ctl.agent.messages.push(msg);
    this.ctl.transcript.message(msg);
    this.draw();
  }

  private bashAbort: (() => void) | null = null;
  private modelWasPicked = false;

  // --------------------------------------------------------------------- turn

  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
      this.draw();
    }, 90);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
  }

  private async runTurn(events: AsyncGenerator<AgentEvent>): Promise<void> {
    this.running = true;
    this.phase = 'thinking';
    this.turnStart = Date.now();
    this.turnOutputTokens = 0;
    this.streamChars = 0;
    this.startSpinner();
    this.draw();
    try {
      for await (const ev of events) this.onEvent(ev);
    } catch (err) {
      this.flushStream();
      this.print(c.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    }
    this.flushStream();
    this.toolRuns.clear();
    this.stopSpinner();
    this.running = false;
    if (this.ctl.settings.bell) process.stdout.write('\x07');
    void this.refreshStatusLine();
    this.draw();

    const leftover = this.ctl.flushQueued();
    if (leftover) await this.runTurn(leftover);
  }

  /** Commit whatever is left of the streaming assistant message. */
  private flushStream(): void {
    if (this.md) {
      const lines = this.md.flush();
      this.printAssistant(lines);
      if (this.mdPrinted) this.screen.print('');
      this.md = null;
      this.mdPrinted = false;
    }
  }

  private printAssistant(lines: string[]): void {
    if (lines.length === 0) return;
    if (!this.mdPrinted) {
      // Drop leading blanks and put the bullet on the first real line.
      while (lines.length && lines[0]!.trim() === '') lines.shift();
      if (lines.length === 0) return;
      lines = withBullet(lines);
      this.mdPrinted = true;
    }
    this.screen.print(lines);
  }

  private commitThinking(): void {
    if (!this.thinking.trim()) return;
    const seconds = Math.max(1, Math.round((Date.now() - this.thinkingStart) / 1000));
    if (this.verbose) {
      const body = wrapText(this.thinking.trim(), this.screen.width, { indent: '  ' });
      this.screen.print([c.dim(`✻ Thinking (${seconds}s)`), ...body.map((l) => c.dim(c.italic(l))), '']);
    } else if (seconds >= 2) {
      this.screen.print([c.dim(`✻ Thought for ${seconds}s`), '']);
    }
    this.thinking = '';
  }

  private onEvent(ev: AgentEvent): void {
    switch (ev.type) {
      case 'stream_start':
        this.phase = 'thinking';
        this.thinking = '';
        this.thinkingStart = Date.now();
        this.streamChars = 0;
        break;
      case 'thinking':
        this.thinking += ev.text;
        this.streamChars += ev.text.length;
        break;
      case 'text':
        if (!this.md) {
          this.commitThinking();
          this.md = new MarkdownStream({ width: () => this.screen.width, indent: '  ' });
          this.mdPrinted = false;
        }
        this.phase = 'responding';
        this.streamChars += ev.text.length;
        this.printAssistant(this.md.push(ev.text));
        break;
      case 'assistant':
        this.commitThinking();
        this.flushStream();
        break;
      case 'user_message':
        this.screen.print([...renderUserPrompt(ev.message.display ?? messageText(ev.message.content), this.screen.width), '']);
        break;
      case 'tool_start':
        this.phase = 'tools';
        this.toolRuns.set(ev.call.id, { name: ev.call.name, label: ev.label, startedAt: Date.now(), progress: '' });
        this.toolLabels.set(ev.call.id, { name: ev.call.name, label: ev.label });
        break;
      case 'tool_progress': {
        const run = this.toolRuns.get(ev.id);
        if (run) run.progress = ev.text;
        break;
      }
      case 'tool_end':
        this.toolRuns.delete(ev.call.id);
        this.printToolResult(ev.call.id, ev.call.name, ev.result);
        break;
      case 'usage':
        this.turnOutputTokens += ev.usage.outputTokens;
        this.streamChars = 0;
        if (ev.usage.tokensPerSecond) this.lastSpeed = ev.usage.tokensPerSecond;
        break;
      case 'notice': {
        const color = ev.level === 'error' ? c.red : ev.level === 'warn' ? c.yellow : c.dim;
        this.screen.print(wrapText(ev.text, this.screen.width).map((l) => color(l)));
        break;
      }
      case 'compact':
        if (ev.phase === 'start') this.phase = 'compacting';
        else {
          this.screen.print([c.dim(`✻ Conversation compacted (${formatCount(ev.before ?? 0)} → ${formatCount(ev.after ?? 0)} tokens)`), '']);
          this.phase = 'thinking';
        }
        break;
      case 'done':
        this.flushStream();
        if (ev.reason === 'error') this.screen.print([...wrapText(`Error: ${ev.error ?? 'unknown error'}`, this.screen.width).map((l) => c.red(l)), '']);
        else if (ev.reason === 'aborted') this.screen.print([c.dim('  Interrupted. Tell coco what to do instead.'), '']);
        else if (ev.reason === 'rejected') this.screen.print([c.dim('  Declined. Tell coco what to do instead.'), '']);
        break;
    }
  }

  private printToolResult(id: string, fallbackName: string, result: ToolResult): void {
    const info = this.toolLabels.get(id) ?? { name: fallbackName, label: '' };
    this.toolLabels.delete(id);
    const lines = renderToolResult(info.name, info.label, result, { width: this.screen.width, verbose: this.verbose, todos: this.ctl.session.todos });
    this.screen.print([...lines, '']);
  }

  // ------------------------------------------------------------------ dialogs

  private async askPermission(p: PermissionPrompt): Promise<PermissionAnswer> {
    const width = this.screen.width;
    const title =
      p.request.kind === 'bash' ? 'Bash command' : p.request.kind === 'edit' ? p.request.description : p.request.kind === 'web' ? 'Network access' : p.request.kind === 'mcp' ? 'MCP tool' : p.toolName;
    const header: string[] = ['', ` ${c.bold(c.yellow(title))}`];
    if (p.request.kind === 'bash') {
      header.push(...wrapText(p.request.target ?? '', width - 1, { indent: '   ', hard: false }).slice(0, 12));
      const description = p.call.arguments.description;
      if (typeof description === 'string' && description.trim()) header.push(c.dim(truncate(`   ${description}`, width)));
    } else if (p.request.kind === 'edit' && p.diff) {
      const hunks = diffLines(p.diff.before ?? '', p.diff.after);
      header.push(...renderDiff(hunks, width, { indent: '  ', maxLines: Math.max(6, this.screen.rows - 14) }));
    } else if (p.request.kind !== 'edit') {
      header.push(...wrapText(p.request.description, width - 1, { indent: '   ' }));
      if (p.request.kind === 'mcp') header.push(c.dim(truncate(`   ${JSON.stringify(p.call.arguments)}`, width)));
    }
    if (p.reason) header.push(...wrapText(p.reason, width - 1, { indent: '   ' }).map((l) => c.dim(l)));
    if (p.warning) header.push(...wrapText(`⚠ ${p.warning}`, width - 1, { indent: '   ' }).map((l) => c.red(l)));
    header.push('');

    type Choice = { allow: boolean; suggestion?: Suggestion };
    const options: DialogOption<Choice>[] = [
      { label: 'Yes', value: { allow: true } },
      ...p.suggestions.map((s) => ({ label: s.label, value: { allow: true, suggestion: s } })),
      { label: 'No, and tell coco what to do differently', value: { allow: false }, input: true, placeholder: 'esc to just decline' },
    ];
    if (this.ctl.settings.bell) process.stdout.write('\x07');
    const result = await this.openSelect<Choice>({ header, question: 'Do you want to proceed?', options, footer: 'enter to confirm · esc to decline' });
    if (!result) return { allow: false };
    return { allow: result.value.allow, suggestion: result.value.suggestion, feedback: result.text };
  }

  private async askQuestions(questions: AskQuestion[], signal: AbortSignal): Promise<Record<string, string> | null> {
    const answers: Record<string, string> = {};
    for (const q of questions) {
      if (signal.aborted) return null;
      const options: DialogOption<string>[] = [
        ...q.options.map((o) => ({ label: o.label, value: o.label, hint: o.description })),
        { label: 'Other', value: '__other__', input: true, placeholder: 'type your answer' },
      ];
      const result = await this.openSelect<string>({
        header: ['', q.header ? ` ${c.bold(c.cyan(q.header))}` : ''].filter((l, i) => i === 0 || l),
        question: q.question,
        options,
        multi: q.multiSelect,
      });
      if (!result) return null;
      if (result.text) answers[q.question] = q.multiSelect ? [...result.values.filter((v) => v !== '__other__'), result.text].join(', ') : result.text;
      else answers[q.question] = q.multiSelect ? result.values.filter((v) => v !== '__other__').join(', ') : result.value;
    }
    return answers;
  }

  private async approvePlan(plan: string, _signal: AbortSignal): Promise<{ approved: boolean; feedback?: string; mode?: PermissionMode }> {
    const width = this.screen.width;
    this.screen.print(['', c.bold(c.cyan(' Proposed plan')), c.dim(` ${'─'.repeat(Math.max(4, width - 2))}`), ...renderMarkdown(plan, width, '  '), c.dim(` ${'─'.repeat(Math.max(4, width - 2))}`)]);
    type Choice = { approved: boolean; mode?: PermissionMode };
    const result = await this.openSelect<Choice>({
      question: 'Go ahead with this plan?',
      options: [
        { label: 'Yes, and accept edits without asking', value: { approved: true, mode: 'acceptEdits' } },
        { label: 'Yes, and ask before each edit', value: { approved: true, mode: 'default' } },
        { label: 'No, keep planning', value: { approved: false }, input: true, placeholder: 'what should change?' },
      ],
    });
    if (!result) return { approved: false };
    return { approved: result.value.approved, mode: result.value.mode, feedback: result.text };
  }

  // -------------------------------------------------------------- status line

  private async refreshStatusLine(): Promise<void> {
    const config = this.ctl.settings.statusLine;
    if (!config?.command || !this.ctl.client) return;
    const input = JSON.stringify({
      session_id: this.ctl.session.id,
      cwd: this.ctl.session.cwd,
      model: { id: this.ctl.client.model, provider: this.ctl.provider.name },
      context: { used: this.ctl.agent.contextTokens(), window: this.ctl.client.profile.contextWindow },
      permission_mode: this.ctl.permissions.mode,
      version: VERSION,
    });
    try {
      const { shell, args } = shellPath();
      const out = await new Promise<string>((resolve) => {
        const child = spawn(shell, args(config.command), { cwd: this.ctl.session.cwd, env: commandEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
        let data = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.stdout.on('data', (d: Buffer) => (data += d.toString('utf8')));
        child.on('error', () => resolve(''));
        child.on('close', () => {
          clearTimeout(timer);
          resolve(data);
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      });
      this.statusLine = out.split('\n')[0]?.trim() ?? '';
      this.draw();
    } catch {
      this.statusLine = '';
    }
  }

  // --------------------------------------------------------------------- draw

  private spinnerLine(): string {
    const elapsed = Date.now() - this.turnStart;
    const runningTools = [...this.toolRuns.values()];
    const label =
      this.phase === 'compacting'
        ? 'Compacting conversation'
        : runningTools.length
          ? `Running ${runningTools[0]!.name}`
          : this.phase === 'responding'
            ? 'Responding'
            : 'Thinking';
    const tokens = this.turnOutputTokens + Math.round(this.streamChars / 3.5);
    const parts = [formatDuration(elapsed)];
    if (tokens > 0) parts.push(`↓ ${formatCount(tokens)} tokens`);
    if (this.lastSpeed > 0) parts.push(`${this.lastSpeed.toFixed(0)} tok/s`);
    parts.push('esc to interrupt');
    return `${c.cyan(SPINNER[this.spinnerFrame]!)} ${c.cyan(`${label}…`)} ${c.dim(`(${parts.join(' · ')})`)}`;
  }

  private footer(width: number): string {
    const ctl = this.ctl;
    let left: string;
    if (this.notice) left = c.yellow(this.notice);
    else if (this.statusLine) left = this.statusLine;
    else {
      const mode = ctl.permissions.mode;
      const color = mode === 'plan' ? c.cyan : mode === 'acceptEdits' ? c.magenta : mode === 'bypassPermissions' ? c.red : c.dim;
      left = mode === 'default' ? c.dim('? /help · shift+tab to change mode') : color(`⏵⏵ ${modeLabel(mode)} (shift+tab to cycle)`);
    }
    let right = '';
    if (ctl.client && ctl.agent) {
      const used = ctl.agent.contextTokens();
      const pct = Math.min(100, Math.round((used / ctl.client.profile.contextWindow) * 100));
      const color = pct > 85 ? c.red : pct > 65 ? c.yellow : c.dim;
      right = `${c.dim(truncate(ctl.client.model, 32))} ${c.dim('·')} ${color(`${pct}% context`)}`;
    }
    const gap = width - stringWidth(left) - stringWidth(right) - 2;
    if (gap < 1) return `  ${truncate(left, width - 2)}`;
    return `  ${left}${' '.repeat(gap)}${right}`;
  }

  /** Build and show the live region. */
  private draw(): void {
    if (this.exiting) return;
    const width = this.screen.width;
    const lines: string[] = [];
    let cursor: { row: number; col: number } | null = null;

    // Streaming assistant text that is not final yet.
    if (this.md) {
      let pending = this.md.pending();
      if (!this.mdPrinted) {
        while (pending.length && pending[0]!.trim() === '') pending = pending.slice(1);
        pending = withBullet(pending);
      }
      const max = Math.max(4, Math.floor(this.screen.rows / 2));
      lines.push(...pending.slice(-max));
    } else if (this.running && this.phase === 'thinking' && this.thinking.trim()) {
      const tail = wrapText(this.thinking.trim().slice(-600), width, { indent: '  ' }).slice(-3);
      lines.push(...tail.map((l) => c.dim(c.italic(l))));
    }

    for (const run of this.toolRuns.values()) {
      if (this.dialog && (run.name === 'AskUserQuestion' || run.name === 'ExitPlanMode')) continue;
      lines.push(toolHeader(run.name, run.label, width, 'running'));
      const tail = run.progress.replace(/\s+$/, '').split('\n').slice(-4);
      for (const l of tail) if (l.trim()) lines.push(c.dim(truncate(`  │ ${l}`, width)));
    }

    // While a dialog waits for the user nothing is running, so no spinner.
    if (this.running && !this.dialog) {
      if (lines.length) lines.push('');
      lines.push(this.spinnerLine());
      const todos = this.ctl.session.todos;
      if (todos.length && todos.some((t) => t.status !== 'completed')) lines.push(...renderTodos(todos, width, '  ').slice(0, 8));
      for (const q of this.ctl.queued) {
        lines.push(c.dim(truncate(`  ↳ queued: ${(q.display ?? messageText(q.content)).replace(/\s+/g, ' ')}`, width)));
      }
    }

    if (this.dialog) {
      const rendered = this.dialog.render(width);
      const offset = lines.length;
      lines.push(...rendered.lines);
      cursor = rendered.cursor ? { row: offset + rendered.cursor.row, col: rendered.cursor.col } : null;
      this.screen.setLive(lines, cursor);
      return;
    }

    // Prompt box
    const text = this.editor.text;
    const bashMode = text.startsWith('!');
    const memoryMode = text.startsWith('#');
    const borderColor = bashMode ? c.magenta : memoryMode ? c.yellow : this.ctl.permissions.mode === 'plan' ? c.cyan : c.dim;
    const rule = borderColor('─'.repeat(width));
    lines.push(rule);
    const layout = this.editor.layout(Math.max(10, width - 2));
    const promptChar = bashMode ? c.magenta('>') : memoryMode ? c.yellow('>') : c.bold('>');
    const inputStart = lines.length;
    if (this.editor.isEmpty) {
      const hint = this.running ? 'Type to queue a message for when the model is done' : 'Ask coco to do something';
      lines.push(`${promptChar} ${c.dim(truncate(hint, width - 2))}`);
    } else {
      // Keep the cursor row visible when the prompt is taller than the space for it.
      const maxRows = Math.max(3, this.screen.rows - 8);
      let first = 0;
      if (layout.rows.length > maxRows) first = Math.min(Math.max(0, layout.cursorRow - maxRows + 1), layout.rows.length - maxRows);
      layout.rows.slice(first, first + maxRows).forEach((row, i) => lines.push(`${i === 0 && first === 0 ? promptChar : ' '} ${row}`));
      layout.cursorRow -= first;
    }
    cursor = { row: inputStart + layout.cursorRow, col: 2 + layout.cursorCol };
    lines.push(rule);

    if (this.completion) {
      const comp = this.completion;
      const start = Math.min(Math.max(0, comp.index - MAX_COMPLETIONS + 1), Math.max(0, comp.items.length - MAX_COMPLETIONS));
      const labelWidth = Math.min(40, Math.max(...comp.items.map((i) => stringWidth(i.label))) + 2);
      comp.items.slice(start, start + MAX_COMPLETIONS).forEach((item, i) => {
        const selected = start + i === comp.index;
        const label = padEnd(truncate(item.label, labelWidth), labelWidth);
        const line = `  ${selected ? c.cyan(label) : label}${item.hint ? c.dim(` ${item.hint}`) : ''}`;
        lines.push(truncate(selected ? c.bold(line) : line, width));
      });
    } else {
      lines.push(this.footer(width));
    }
    this.screen.setLive(lines, cursor);
  }
}

/** Prefix matches first, then substring matches; shorter names first. */
export function rankCommands(commands: ResolvedCommand[], query: string): ResolvedCommand[] {
  const q = query.toLowerCase();
  const scored = commands
    .map((cmd) => {
      const name = cmd.name.toLowerCase();
      const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : cmd.description.toLowerCase().includes(q) && q.length > 2 ? 2 : -1;
      return { cmd, score };
    })
    .filter((s) => s.score >= 0);
  scored.sort((a, b) => a.score - b.score || a.cmd.name.localeCompare(b.cmd.name));
  return scored.map((s) => s.cmd);
}

/** Rank project files for an @-mention query. */
export function rankFiles(files: string[], query: string, limit = 50): string[] {
  if (!query) return files.slice(0, limit);
  const q = query.toLowerCase();
  const scored: { file: string; score: number }[] = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let score: number;
    if (base === q) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (lower.startsWith(q)) score = 2;
    else if (base.includes(q)) score = 3;
    else if (lower.includes(q)) score = 4;
    else if (isSubsequence(q, lower)) score = 6;
    else continue;
    scored.push({ file, score: score * 1000 + file.length });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.file);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

export async function runInteractive(ctl: Controller, opts: InteractiveOptions = {}): Promise<number> {
  return new App(ctl).run(opts);
}

export { BULLET };
