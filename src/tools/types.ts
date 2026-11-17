import type { ImagePart, JsonSchema } from '../types.ts';
import type { Settings } from '../config/settings.ts';
import type { SessionState } from '../session/state.ts';

/** A before/after pair the UI renders as a diff. `before` is null for a new file. */
export interface FileDiff {
  path: string;
  before: string | null;
  after: string;
}

export interface ToolResult {
  /** Text returned to the model. */
  content: string;
  isError?: boolean;
  /** One-line result shown in the transcript, e.g. "Read 42 lines". Falls back to the content. */
  summary?: string;
  diff?: FileDiff;
  images?: ImagePart[];
}

export type PermissionKind = 'read' | 'edit' | 'bash' | 'web' | 'mcp' | 'other';

/** What a tool call needs approval for. Rules are matched against `tool` and `target`. */
export interface PermissionRequest {
  /** Name used in permission rules: Bash, Read, Edit, WebFetch, mcp__server__tool, ... */
  tool: string;
  kind: PermissionKind;
  /** Command for Bash, absolute path for file tools, "domain:host" for WebFetch. */
  target?: string;
  /** Shown to the user in the approval dialog. */
  description: string;
}

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  /** Short tag shown next to the question. */
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface SubagentRequest {
  type?: string;
  description: string;
  prompt: string;
  signal: AbortSignal;
  depth: number;
  onProgress?: (text: string) => void;
}

export interface SubagentResult {
  text: string;
  toolUses: number;
  tokens: number;
  isError?: boolean;
}

export interface SkillInfo {
  name: string;
  description: string;
  /** Directory holding SKILL.md and any bundled files. */
  baseDir: string;
  body: string;
}

/**
 * Services the agent runtime offers to tools. Interactive members are absent
 * in headless runs, and tools must cope with that.
 */
export interface RuntimeHandle {
  runSubagent(req: SubagentRequest): Promise<SubagentResult>;
  agentTypes(): { name: string; description: string }[];
  skills(): { name: string; description: string }[];
  loadSkill(name: string): SkillInfo | undefined;
  askUser?(questions: AskQuestion[], signal: AbortSignal): Promise<Record<string, string> | null>;
  approvePlan?(plan: string, signal: AbortSignal): Promise<{ approved: boolean; feedback?: string }>;
  todosChanged?(): void;
}

export interface ToolContext {
  /** Current working directory of the session (follows `cd` in Bash). */
  cwd: string;
  signal: AbortSignal;
  settings: Settings;
  session: SessionState;
  toolCallId: string;
  /** 0 for the main agent, 1+ inside a subagent. */
  depth: number;
  /** Streams partial output to the UI while the tool runs. */
  onProgress?: (text: string) => void;
  runtime?: RuntimeHandle;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Tool<I = any> {
  name: string;
  /** Model-facing description. Keep it short: local models have small context windows. */
  description: string;
  parameters: JsonSchema;
  /**
   * Repair argument shapes models commonly get wrong, before validation.
   * The schema stays strict (it is what the model is shown); this accepts near misses.
   */
  normalize?(raw: Record<string, unknown>): Record<string, unknown>;
  /** Read-only calls are allowed in plan mode and may run concurrently. */
  isReadOnly(input: I): boolean;
  /** What needs approval, or null when the call never needs it. */
  permission?(input: I, ctx: ToolContext): PermissionRequest | null;
  /** Short argument summary for the transcript, e.g. the file path. */
  label?(input: I, ctx: ToolContext): string;
  /** What the call would change, shown in the approval dialog. Must not modify anything. */
  preview?(input: I, ctx: ToolContext): FileDiff | null;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export function errorResult(message: string): ToolResult {
  return { content: message, isError: true };
}
