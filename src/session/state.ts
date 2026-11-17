import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Settings } from '../config/settings.ts';
import { expandHome, fileHistoryDir } from '../config/paths.ts';
import { ShellManager } from '../tools/shell.ts';
import { Checkpoints } from './checkpoints.ts';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Present-tense form shown while the item is in progress. */
  activeForm?: string;
}

export interface ReadRecord {
  mtimeMs: number;
  /** True when only part of the file was read (offset/limit). */
  partial: boolean;
}

export interface SessionInit {
  id?: string;
  cwd: string;
  settings: Settings;
}

/** Mutable state shared by every tool call in a session. */
export class SessionState {
  id: string;
  /** Current working directory; `cd` in the Bash tool moves it. */
  cwd: string;
  /** Directory coco was started in. File access outside it needs approval. */
  readonly projectRoot: string;
  additionalDirs: string[] = [];
  settings: Settings;
  /** Files the model has read, so edits can require a read first and detect outside changes. */
  readFiles = new Map<string, ReadRecord>();
  todos: TodoItem[] = [];
  /** Index of the current user turn (used to key file checkpoints). */
  turn = 0;
  /** Whether the active model accepts images. */
  vision = false;
  checkpoints: Checkpoints;
  shells = new ShellManager();

  constructor(init: SessionInit) {
    this.id = init.id ?? crypto.randomUUID();
    this.cwd = path.resolve(init.cwd);
    this.projectRoot = this.cwd;
    this.settings = init.settings;
    this.checkpoints = new Checkpoints(fileHistoryDir(this.id));
    for (const dir of init.settings.permissions?.additionalDirectories ?? []) this.addDir(dir);
  }

  addDir(dir: string): string {
    const abs = path.resolve(this.projectRoot, expandHome(dir));
    if (!this.additionalDirs.includes(abs)) this.additionalDirs.push(abs);
    return abs;
  }

  workingDirs(): string[] {
    return [this.projectRoot, ...this.additionalDirs];
  }

  /** True when `absPath` is inside the project or an added directory. */
  inWorkingDirs(absPath: string): boolean {
    const target = realpathSafe(absPath);
    return this.workingDirs().some((dir) => isInside(target, realpathSafe(dir)));
  }
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** Resolve symlinks for the longest existing prefix of a path. */
export function realpathSafe(p: string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}
