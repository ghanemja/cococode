import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Settings } from '../src/config/settings.ts';
import { SessionState } from '../src/session/state.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { setColorEnabled } from '../src/ui/ansi.ts';

setColorEnabled(false);

/** A fresh temp directory, with the user config directories pointed inside it so tests never touch ~/.coco or ~/.claude. */
export function tempProject(prefix = 'coco-test-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  process.env.COCO_CONFIG_DIR = path.join(dir, '.coco-home');
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, '.claude-home');
  return dir;
}

export function makeContext(cwd: string, settings: Settings = {}): ToolContext {
  const session = new SessionState({ cwd, settings });
  return {
    get cwd() {
      return session.cwd;
    },
    signal: new AbortController().signal,
    settings,
    session,
    toolCallId: 'test',
    depth: 0,
  };
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}
