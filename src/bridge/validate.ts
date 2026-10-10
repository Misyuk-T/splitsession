/**
 * A small validator for the subset of JSON Schema the bridge tools use. The same schema objects are sent to MCP
 * clients as `inputSchema`, so what is advertised is what is enforced (on both sides of the bridge).
 */

export interface Schema {
  type?: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'null' | Array<'string' | 'integer' | 'number' | 'boolean' | 'null'>;
  description?: string;
  enum?: readonly (string | number | boolean | null)[];
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  /** Strings: a regular expression the whole value must match (anchor it yourself). */
  pattern?: string;
  /** Arrays: the schema of every item, and the bounds of the length. */
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export type Validation = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

const typeOf = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

function matchesType(type: NonNullable<Schema['type']>, value: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    switch (t) {
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'null':
        return value === null;
      case 'object':
        return typeOf(value) === 'object';
      case 'array':
        return Array.isArray(value);
      default:
        return typeof value === t;
    }
  });
}

function check(schema: Schema, value: unknown, path: string): string | null {
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    const wanted = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type;
    return `${path}: expected ${wanted}, got ${typeOf(value)}`;
  }
  if (schema.enum && !schema.enum.includes(value as never)) return `${path}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path}: must not be shorter than ${schema.minLength} characters`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path}: must not be longer than ${schema.maxLength} characters`;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) return `${path}: ${JSON.stringify(value.slice(0, 40))} has the wrong form`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path}: needs at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path}: takes at most ${schema.maxItems} items`;
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const problem = check(schema.items, value[i], `${path}[${i}]`);
        if (problem) return problem;
      }
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path}: must be at least ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path}: must be at most ${schema.maximum}`;
  }
  return null;
}

/** Validates an object against an object schema and fills in defaults. Unknown keys are errors. */
export function validateArgs(schema: Schema, input: unknown): Validation {
  const raw = input === undefined || input === null ? {} : input;
  if (typeOf(raw) !== 'object') return { ok: false, error: `arguments must be an object, got ${typeOf(raw)}` };
  const args = raw as Record<string, unknown>;
  const properties = schema.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(args)) {
    if (!(key in properties) && schema.additionalProperties !== true) return { ok: false, error: `unknown argument "${key}"` };
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) return { ok: false, error: `missing required argument "${key}"` };
  }
  for (const [key, prop] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined) {
      if (prop.default !== undefined) out[key] = prop.default;
      continue;
    }
    const problem = check(prop, value, key);
    if (problem) return { ok: false, error: problem };
    out[key] = value;
  }
  return { ok: true, value: out };
}
