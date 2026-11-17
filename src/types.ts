/** Core message and tool types shared by providers, the agent loop, tools and the UI. */

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  /** e.g. image/png */
  mediaType: string;
  /** base64 without the data: prefix */
  data: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Set when the model produced arguments that were not valid JSON. */
  parseError?: string;
}

export type StopReason = 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock generation time for this response, if the server reported it. */
  evalMs?: number;
  tokensPerSecond?: number;
}

export interface UserMessage {
  role: 'user';
  content: string | ContentPart[];
  /** Synthetic message (hook feedback, reminders, compaction summaries). Hidden in the transcript view. */
  isMeta?: boolean;
  /** User turn number, used to key file checkpoints for /rewind. Not sent to the model. */
  turn?: number;
  /** What the user typed, when `content` also carries attached files or command expansions. */
  display?: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  usage?: Usage;
  model?: string;
  stopReason?: StopReason;
}

export interface ToolResultMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
  images?: ImagePart[];
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
};

/** What a provider needs to know about a tool. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk';

export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'];

export function messageText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}
