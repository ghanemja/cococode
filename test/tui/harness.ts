/**
 * Runs the interactive UI in a pseudo-terminal (via drive.py) and returns the
 * rendered screens. The child is spawned asynchronously so an in-process mock
 * model server keeps answering while the UI runs.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Step =
  | { wait: string; timeout?: number }
  | { send: string; after?: number }
  | { sleep: number }
  | { snapshot: string; full?: boolean }
  | { resize: [number, number] };

export interface TuiSpec {
  cwd: string;
  env?: Record<string, string>;
  args?: string[];
  cols?: number;
  rows?: number;
  steps: Step[];
}

export interface TuiResult {
  snapshots: Record<string, string>;
  /** Cursor position (row, column) at each snapshot. */
  cursors: Record<string, [number, number]>;
  /** Set when a `wait` step timed out: the screen at that moment. */
  timedOut?: { waitingFor: string; screen: string };
  raw: string;
}

const DRIVER = fileURLToPath(new URL('./drive.py', import.meta.url));

/** True when python3 and pyte are installed, which the pty driver needs. */
export function tuiAvailable(): boolean {
  if (process.platform === 'win32') return false;
  const probe = spawnSync('python3', ['-c', 'import pyte, pty'], { stdio: 'ignore' });
  return probe.status === 0;
}

export function runTui(spec: TuiSpec, timeoutMs = 60_000): Promise<TuiResult> {
  const specFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-tui-spec-')), 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [DRIVER, specFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      fs.rmSync(path.dirname(specFile), { recursive: true, force: true });
      if (stderr.trim() && !stdout.includes('<<<')) {
        reject(new Error(`pty driver failed: ${stderr}`));
        return;
      }
      const snapshots: Record<string, string> = {};
      const cursors: Record<string, [number, number]> = {};
      const re = /<<<SNAPSHOT (\S+) cursor=(\d+),(\d+)>>>\n([\s\S]*?)\n<<<END>>>/g;
      for (let m = re.exec(stdout); m; m = re.exec(stdout)) {
        snapshots[m[1]!] = m[4]!;
        cursors[m[1]!] = [Number(m[2]), Number(m[3])];
      }
      const timeout = /<<<TIMEOUT waiting for '([\s\S]*?)'>>>\n([\s\S]*?)\n<<<END>>>/.exec(stdout);
      resolve({ snapshots, cursors, timedOut: timeout ? { waitingFor: timeout[1]!, screen: timeout[2]! } : undefined, raw: stdout });
    });
  });
}
