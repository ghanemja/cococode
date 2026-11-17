import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface Snapshot {
  /** User turn during which the file was first modified. */
  turn: number;
  path: string;
  /** Backup file holding the previous content, or null if the file did not exist. */
  backup: string | null;
  /** Permission bits of the original file, so an executable stays executable. */
  mode?: number;
}

/**
 * File checkpoints. Before a tool modifies a file we save what was there, keyed
 * by the user turn. Rewinding to turn N restores every file touched in turn N
 * or later to its state from just before that turn.
 *
 * Only edits made through the file tools are tracked; side effects of shell
 * commands are not.
 */
export class Checkpoints {
  private snapshots: Snapshot[] = [];
  private readonly dir: string;
  private readonly indexFile: string;

  constructor(dir: string) {
    this.dir = dir;
    this.indexFile = path.join(dir, 'index.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as unknown;
      this.snapshots = Array.isArray(parsed)
        ? (parsed as Snapshot[]).filter((s) => s && typeof s.path === 'string' && typeof s.turn === 'number' && (s.backup === null || typeof s.backup === 'string'))
        : [];
    } catch {
      this.snapshots = [];
    }
  }

  /** Record the current content of `absPath` before it is modified in `turn`. */
  track(absPath: string, turn: number): void {
    if (this.snapshots.some((s) => s.turn === turn && s.path === absPath)) return;
    let backup: string | null = null;
    let mode: number | undefined;
    let data: Buffer | undefined;
    try {
      data = fs.readFileSync(absPath);
      mode = fs.statSync(absPath).mode & 0o7777;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return; // unreadable: nothing to restore to
    }
    if (data !== undefined) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        const hash = crypto.createHash('sha1').update(absPath).digest('hex').slice(0, 16);
        backup = path.join(this.dir, `${hash}@${turn}`);
        fs.writeFileSync(backup, data);
      } catch {
        return; // could not save a copy, so there is nothing to rewind to
      }
    }
    const snapshot: Snapshot = { turn, path: absPath, backup };
    if (mode !== undefined) snapshot.mode = mode;
    this.snapshots.push(snapshot);
    this.persist();
  }

  /** Files that would change if we rewound to just before `turn`. */
  changedSince(turn: number): string[] {
    return [...new Set(this.snapshots.filter((s) => s.turn >= turn).map((s) => s.path))];
  }

  /**
   * Restore every file modified in `turn` or later. Returns the restored paths.
   */
  rewindTo(turn: number): { restored: string[]; failed: string[] } {
    const restored: string[] = [];
    const failed: string[] = [];
    const earliest = new Map<string, Snapshot>();
    for (const snap of this.snapshots) {
      if (snap.turn < turn) continue;
      const prev = earliest.get(snap.path);
      if (!prev || snap.turn < prev.turn) earliest.set(snap.path, snap);
    }
    for (const snap of earliest.values()) {
      try {
        if (snap.backup === null) {
          fs.rmSync(snap.path, { force: true });
        } else {
          fs.mkdirSync(path.dirname(snap.path), { recursive: true });
          fs.copyFileSync(snap.backup, snap.path);
          if (snap.mode !== undefined && process.platform !== 'win32') fs.chmodSync(snap.path, snap.mode);
        }
        restored.push(snap.path);
      } catch {
        failed.push(snap.path);
      }
    }
    // Keep the snapshots of files that could not be restored, so a retry is possible.
    const stuck = new Set(failed);
    this.snapshots = this.snapshots.filter((s) => s.turn < turn || stuck.has(s.path));
    this.persist();
    return { restored, failed };
  }

  /** Highest turn with a snapshot, or 0. A resumed session must number new turns above this. */
  lastTurn(): number {
    return this.snapshots.reduce((max, s) => Math.max(max, s.turn), 0);
  }

  private persist(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.indexFile, JSON.stringify(this.snapshots));
    } catch {
      // Checkpoints are best effort; never fail an edit because of them.
    }
  }
}
