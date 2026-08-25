import { MycoConfigSchema } from './schema.js';

/**
 * Every leaf the config schema DECLARES, including the optional ones.
 *
 * `enumerateLeafPaths` walks a parsed, defaulted config, which is the right
 * input for most questions and the wrong one for coverage: a leaf declared
 * `.optional()` with no default never appears in a defaulted parse, so it is
 * invisible to anything that enumerates that way.
 *
 * The leaves that go missing are not a random sample. `agent.provider` and
 * `embedding.base_url` are optional, and they carry the endpoint and credential
 * material — precisely the settings a coverage gate most needs to see. A gate
 * built on the defaulted parse cannot fail for them, whatever they do.
 *
 * This walks the schema itself, unwrapping the wrappers Zod puts around a type
 * (`optional`, `default`, `nullable`, `catch`, `pipe`, `readonly`) until it
 * reaches an object shape or a leaf.
 */

/** Wrappers that hold the real type one level down; unwrapped until an object or leaf is reached. */
const WRAPPERS = new Set(['optional', 'default', 'nullable', 'catch', 'readonly', 'nonoptional', 'prefault']);

const MAX_UNWRAP = 16;

function unwrap(schema: unknown): unknown {
  let s = schema as { _def?: Record<string, unknown> } | undefined;
  for (let i = 0; i < MAX_UNWRAP; i += 1) {
    const def = s?._def as Record<string, unknown> | undefined;
    if (def === undefined) break;
    const type = def.type as string | undefined;
    if (type === undefined) break;
    if (WRAPPERS.has(type)) { s = def.innerType as typeof s; continue; }
    // A pipe's OUTPUT is the shape a consumer sees.
    if (type === 'pipe') { s = def.out as typeof s; continue; }
    break;
  }
  return s;
}

/**
 * Shapes that legitimately end a walk.
 *
 * A `record`'s children are dynamic and cannot be enumerated from the schema, so
 * it is a leaf here and the ledger classifies the block whole. The rest are values.
 */
const TERMINAL = new Set([
  'record',
  // A union is ONE setting whose value has alternatives, not a subtree of
  // independent settings — `thinking_budget_map.low` is `{budgetTokens} | {adaptive}`
  // and is a single thing an operator sets. Walking its branches would invent leaf
  // paths no one configures.
  'union', 'discriminated_union',
  'string', 'number', 'boolean', 'enum', 'literal', 'array', 'any', 'unknown',
  'null', 'undefined', 'date', 'map', 'set', 'tuple', 'bigint', 'symbol', 'never',
  'void', 'nan', 'file', 'custom', 'template_literal',
]);

export class UnknownSchemaShapeError extends Error {
  constructor(public readonly shape: string, public readonly path: string) {
    super(`declared-leaves: unrecognised schema shape '${shape}' at '${path || '<root>'}'`);
    this.name = 'UnknownSchemaShapeError';
  }
}

/**
 * The object shape at this node, or null when the node is a value.
 *
 * Throws on a shape it does not recognise rather than treating it as a leaf. That
 * is the whole point: an unrecognised shape collapses its entire subtree to one
 * path, and the coverage gate cannot tell that from a legitimate dynamic block —
 * so the author adds one ledger row, the gate goes green, and everything beneath
 * it is unclassified. Silently under-reporting is the exact defect this module
 * exists to fix, so it fails by name instead.
 */
function shapeOf(schema: unknown, path: string): Record<string, unknown> | null {
  const s = unwrap(schema) as { _def?: { type?: string; shape?: Record<string, unknown> }; shape?: Record<string, unknown> } | undefined;
  const type = s?._def?.type;
  if (type === 'object') return s!._def!.shape ?? s!.shape ?? null;
  if (type === undefined || TERMINAL.has(type)) return null;
  throw new UnknownSchemaShapeError(type, path);
}

function walk(schema: unknown, prefix: string, out: string[]): void {
  const shape = shapeOf(schema, prefix);
  if (shape === null) {
    if (prefix) out.push(prefix);
    return;
  }
  for (const [key, value] of Object.entries(shape)) {
    walk(value, prefix ? `${prefix}.${key}` : key, out);
  }
}

/** Sorted leaf paths of every declared setting, optional ones included. */
export function declaredLeafPaths(): string[] {
  const out: string[] = [];
  walk(MycoConfigSchema, '', out);
  return [...new Set(out)].sort();
}
