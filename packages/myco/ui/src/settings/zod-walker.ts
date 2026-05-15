import { z } from 'zod';
import type { SettingKind } from './manifest';

export interface SchemaField {
  /** Dotted path from the schema root. */
  key: string;
  /** Inferred control kind from the Zod type. */
  kind: SettingKind | 'record' | 'object';
  /** Whether the field is `.optional()`. */
  optional: boolean;
  /** Options for enums. */
  options?: readonly string[];
  /** Min/max for numbers. */
  min?: number;
  max?: number;
}

/**
 * Unwrap one layer of an optional/default/nullable wrapper. Returns the inner
 * schema and a flag indicating whether `.optional()` was seen at any layer.
 */
function readInnerType(def: unknown): z.ZodTypeAny {
  return (def as { innerType: z.ZodTypeAny }).innerType;
}

function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean } {
  let current: z.ZodTypeAny = schema;
  let optional = false;
  while (true) {
    if (current instanceof z.ZodOptional) {
      optional = true;
      current = readInnerType(current._def);
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = readInnerType(current._def);
      continue;
    }
    if (current instanceof z.ZodNullable) {
      current = readInnerType(current._def);
      continue;
    }
    if (current instanceof z.ZodReadonly) {
      current = readInnerType(current._def);
      continue;
    }
    // `z.preprocess(fn, target)` and `schema.pipe(target)` both produce a
    // ZodPipe with `_def.in` (the transform / source) and `_def.out` (the
    // validator). The interesting schema for field-walking is always the
    // output side — that's where the real object/leaf lives. Schema-level
    // pipes used in config (e.g. rejectLegacyRuntimeKey, MachineConfigSchema
    // legacy stripper) follow this shape.
    const def = (current as { _def?: { type?: string; in?: z.ZodTypeAny; out?: z.ZodTypeAny } })._def;
    if (def && def.type === 'pipe' && def.out) {
      current = def.out;
      continue;
    }
    return { inner: current, optional };
  }
}

/**
 * Extract numeric bounds from a `ZodNumber`'s check list. In Zod 4 each check
 * lives under `_zod.def` with a `check` discriminant of `'greater_than'` or
 * `'less_than'` and a `value` field.
 */
function readNumberBounds(schema: z.ZodNumber): { min?: number; max?: number } {
  const checks = (schema._def as { checks?: unknown[] }).checks ?? [];
  let min: number | undefined;
  let max: number | undefined;
  for (const raw of checks) {
    const check = raw as { _zod?: { def?: { check?: string; value?: unknown } } };
    const def = check._zod?.def;
    if (!def || typeof def.value !== 'number') continue;
    if (def.check === 'greater_than') {
      min = min === undefined ? def.value : Math.max(min, def.value);
    } else if (def.check === 'less_than') {
      max = max === undefined ? def.value : Math.min(max, def.value);
    }
  }
  return { min, max };
}

/** Append a path segment to a dotted prefix. */
function join(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

function describeLeaf(
  key: string,
  inner: z.ZodTypeAny,
  optional: boolean,
): SchemaField | null {
  if (inner instanceof z.ZodBoolean) {
    return { key, kind: 'toggle', optional };
  }
  if (inner instanceof z.ZodEnum) {
    const def = inner._def as { entries?: Record<string, string> };
    const options = def.entries ? Object.values(def.entries) : [];
    return { key, kind: 'select', optional, options };
  }
  if (inner instanceof z.ZodNumber) {
    const { min, max } = readNumberBounds(inner);
    const field: SchemaField = { key, kind: 'number', optional };
    if (min !== undefined) field.min = min;
    if (max !== undefined) field.max = max;
    return field;
  }
  if (inner instanceof z.ZodString) {
    return { key, kind: 'text', optional };
  }
  if (inner instanceof z.ZodArray) {
    return { key, kind: 'list', optional };
  }
  if (inner instanceof z.ZodRecord) {
    return { key, kind: 'record', optional };
  }
  if (inner instanceof z.ZodLiteral) {
    return null;
  }
  if (inner instanceof z.ZodUnion) {
    return { key, kind: 'object', optional };
  }
  return { key, kind: 'object', optional };
}

/**
 * Walk a Zod schema and yield one record per leaf field. `ZodObject`s recurse
 * with a dotted-path prefix; wrapper types (`optional`, `default`, `nullable`)
 * are unwrapped so the inner kind is what callers see.
 *
 * Pure: no side effects, no logging, no schema mutation.
 */
export function walkSchemaFields(schema: z.ZodTypeAny, prefix = ''): SchemaField[] {
  const { inner: root, optional: rootOptional } = unwrap(schema);

  if (root instanceof z.ZodObject) {
    const shape = root.shape as Record<string, z.ZodTypeAny>;
    const fields: SchemaField[] = [];
    for (const key of Object.keys(shape)) {
      const child = shape[key];
      if (!child) continue;
      const childKey = join(prefix, key);
      const { inner, optional } = unwrap(child);
      if (inner instanceof z.ZodObject) {
        fields.push(...walkSchemaFields(inner, childKey));
        continue;
      }
      const leaf = describeLeaf(childKey, inner, optional);
      if (leaf) fields.push(leaf);
    }
    return fields;
  }

  if (!prefix) {
    return [];
  }
  const leaf = describeLeaf(prefix, root, rootOptional);
  return leaf ? [leaf] : [];
}
