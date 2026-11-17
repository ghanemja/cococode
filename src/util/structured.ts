/** Structured output for headless runs (--json-schema): the final answer must be JSON of a given shape. */
import type { JsonSchema } from '../types.ts';
import { parseJsonLoose } from './json.ts';
import { validateInput } from './schema.ts';

export function structuredOutputPrompt(schema: JsonSchema): string {
  return [
    '# Output format',
    'When the work is finished, your final message must be a single JSON value that matches this JSON Schema, with no other text and no code fence:',
    JSON.stringify(schema),
  ].join('\n');
}

export type StructuredCheck = { ok: true; value: unknown } | { ok: false; error: string };

/** The JSON in a reply: the whole reply, or else its last fenced block or outermost object. */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fences = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  if (fences.length && !/^[[{"]/.test(trimmed)) return fences[fences.length - 1]![1]!.trim();
  if (/^[[{]/.test(trimmed)) return trimmed;
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/** Read a model's final answer as JSON and check it against the schema. */
export function checkStructured(text: string, schema: JsonSchema): StructuredCheck {
  if (!text.trim()) return { ok: false, error: 'the reply was empty' };
  const parsed = parseJsonLoose(extractJson(text));
  if (!parsed.ok || parsed.truncated) return { ok: false, error: 'the reply is not valid JSON' };
  // The validator covers objects, which is what schemas for structured output describe.
  if (schema.type !== 'object') return { ok: true, value: parsed.value };
  const checked = validateInput(schema, parsed.value);
  if (!checked.ok) return { ok: false, error: checked.error.replace(/^Invalid arguments: /, '').replace(/Arguments must be/, 'The reply must be').replace(/parameters/g, 'properties') };
  return { ok: true, value: checked.value };
}
