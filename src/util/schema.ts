/**
 * Validation and coercion of tool arguments against a JSON schema subset.
 *
 * Local models get argument types slightly wrong all the time: numbers as
 * strings, booleans as "true", arrays as JSON-encoded strings, null for an
 * omitted optional. Coercing those is safer than bouncing the call, and when
 * we do reject, the message tells the model exactly what to fix.
 */
import type { JsonSchema } from '../types.ts';
import { isRecord, parseJsonLoose } from './json.ts';

export type ValidationResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
  return typeof v;
}

function allowedTypes(schema: JsonSchema): string[] {
  if (!schema.type) return [];
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function coerce(value: unknown, schema: JsonSchema, path: string, errors: string[]): unknown {
  const types = allowedTypes(schema);
  const actual = typeOf(value);

  if (schema.enum && !schema.enum.includes(value)) {
    // Case-insensitive match is unambiguous for string enums.
    if (typeof value === 'string') {
      const match = schema.enum.find((e) => typeof e === 'string' && e.toLowerCase() === value.toLowerCase());
      if (match !== undefined) return match;
    }
    errors.push(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')} (got ${JSON.stringify(value)})`);
    return value;
  }

  if (types.length === 0) return value;
  const matches = (t: string) => t === actual || (t === 'number' && actual === 'integer');

  if (!types.some(matches)) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if ((types.includes('number') || types.includes('integer')) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
        const n = Number(trimmed);
        if (types.includes('number') || Number.isInteger(n)) return n;
      }
      if (types.includes('boolean') && /^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
      if ((types.includes('array') || types.includes('object')) && /^[[{]/.test(trimmed)) {
        const parsed = parseJsonLoose(trimmed);
        if (parsed.ok && types.some((t) => t === typeOf(parsed.value))) return coerce(parsed.value, schema, path, errors);
      }
      // A single string where a list of strings is expected.
      if (types.includes('array') && allowedTypes(schema.items ?? {}).includes('string')) return [value];
    }
    if (typeof value === 'number' && types.includes('string')) return String(value);
    if (typeof value === 'boolean' && types.includes('string')) return String(value);
    if (actual === 'number' && types.includes('integer')) return Math.round(value as number);
    errors.push(`${path} must be ${types.join(' or ')} (got ${actual})`);
    return value;
  }

  if (actual === 'array' && schema.items) {
    return (value as unknown[]).map((item, i) => coerce(item, schema.items!, `${path}[${i}]`, errors));
  }
  if (actual === 'object' && schema.properties) {
    return coerceObject(value as Record<string, unknown>, schema, path, errors);
  }
  return value;
}

function coerceObject(input: Record<string, unknown>, schema: JsonSchema, path: string, errors: string[]): Record<string, unknown> {
  const props = schema.properties ?? {};
  const out: Record<string, unknown> = {};
  const prefix = path ? `${path}.` : '';
  for (const [key, raw] of Object.entries(input)) {
    const propSchema = props[key];
    if (!propSchema) {
      // Unknown keys are dropped rather than rejected; models add stray fields.
      if (schema.additionalProperties === true || isRecord(schema.additionalProperties)) out[key] = raw;
      continue;
    }
    const required = schema.required?.includes(key) ?? false;
    // null or empty string for an optional value means "not provided".
    if (!required && (raw === null || raw === undefined || (raw === '' && !allowedTypes(propSchema).includes('string')))) continue;
    out[key] = coerce(raw, propSchema, `${prefix}${key}`, errors);
  }
  for (const key of schema.required ?? []) {
    if (out[key] === undefined || out[key] === null) errors.push(`missing required parameter "${prefix}${key}"`);
  }
  return out;
}

export function validateInput(schema: JsonSchema, input: unknown): ValidationResult {
  if (!isRecord(input)) return { ok: false, error: 'Arguments must be a JSON object.' };
  const errors: string[] = [];
  const value = coerceObject(input, schema, '', errors);
  if (errors.length) {
    const known = Object.keys(schema.properties ?? {});
    const unknown = Object.keys(input).filter((k) => !known.includes(k));
    let message = `Invalid arguments: ${errors.join('; ')}.`;
    if (unknown.length) message += ` Unknown parameters ignored: ${unknown.join(', ')}.`;
    message += ` Expected parameters: ${known.map((k) => (schema.required?.includes(k) ? k : `${k}?`)).join(', ')}.`;
    return { ok: false, error: message };
  }
  return { ok: true, value };
}
