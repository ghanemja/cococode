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
  /**
   * SHA-256 of the file's bytes when it was read. A later change is detected by
   * comparing content, not timestamps. Absent for files too large to hash, and
   * for records made without one; the modification time decides for those.
   */
  hash?: string;
  /** Size in bytes when the file was read. */
  size?: number;
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

  /**
   * Move the foreground Bash commands that are running right now to the
   * background, for a UI key such as Ctrl+B. Each affected Bash call returns at
   * once and tells the model which background shell carries on, so the turn
   * continues while the command keeps running. Returns how many were moved.
   */
  detachForeground(): number {
    return this.shells.detachForeground().length;
  }
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Resolve symlinks for the longest existing prefix of a path. A dangling
 * symlink is followed by hand: writing through it creates its target, so the
 * target is where the path really leads.
 */
export function realpathSafe(p: string, hops = 0): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch {
      let link: string | undefined;
      try {
        if (fs.lstatSync(current).isSymbolicLink()) link = fs.readlinkSync(current);
      } catch {
        link = undefined;
      }
      if (link !== undefined && hops < 40) {
        const target = path.resolve(realpathSafe(path.dirname(current), hops + 1), link);
        return path.join(realpathSafe(target, hops + 1), ...tail);
      }
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}
