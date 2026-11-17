/** Runs the `!` commands written inside a custom command or skill file. */
import { analyzeCommand } from '../permissions/bash.ts';
import { matchBashSpec, parseRule } from '../permissions/rules.ts';
import { runCommand } from '../tools/shell.ts';
import type { PermissionMode } from '../types.ts';

interface InlineHost {
  permissions: { mode: PermissionMode };
  session: { cwd: string };
  settings: { env?: Record<string, string> };
}

/**
 * A runner for inline `!` commands that only runs what the file's
 * allowed-tools cover (or anything, when permissions are bypassed). It is
 * given the final command text, after arguments were filled in, and returns
 * null for a command it will not run.
 */
export function inlineBashRunner(host: InlineHost, allowed: string[] | undefined): (cmd: string) => Promise<string | null> {
  const specs = (allowed ?? [])
    .map((r) => parseRule(r))
    .filter((r): r is NonNullable<ReturnType<typeof parseRule>> => r !== null && r.tool === 'Bash');
  return async (cmd: string) => {
    const analysis = analyzeCommand(cmd);
    const covered =
      host.permissions.mode === 'bypassPermissions' ||
      specs.some((r) => r.spec === undefined) ||
      (!analysis.hasSubstitution && analysis.commands.length > 0 && analysis.commands.every((simple) => specs.some((r) => r.spec !== undefined && matchBashSpec(r.spec, simple))));
    if (!covered) return null;
    const res = await runCommand(cmd, { cwd: host.session.cwd, env: host.settings.env, timeoutMs: 30_000, maxOutput: 10_000 });
    return res.output;
  };
}
