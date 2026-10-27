import { sha256Hex } from '../hash.js';
import { MATERIAL_COLUMNS as VIEW_COLUMNS, type MATERIALS } from '../db/view-tables.js';
import { CONTEXT_MATERIAL_COLUMNS, type MaterialKind } from '../db/view-tables.js';
export type ViewKind = keyof typeof MATERIALS;
const nullable = (value: unknown) => (value === undefined ? null : value);
export const MATERIAL_BODIES = {
  prompt: [['text', 'blob_key', 'prompt']],
  response: [['text', 'blob_key', 'response']],
  plan: [['content', 'blob_key', 'plan']],
  tool: [
    ['input', 'input_blob_key', 'tool-input'],
    ['output_preview', 'output_blob_key', 'tool-output'],
  ],
} as const satisfies Record<ViewKind, readonly (readonly [string, string, string])[]>;

/** Body digests retain complete content identity across inline and verified blob storage. */
export async function materialBodyDigest(
  kind: ViewKind,
  values: Record<string, unknown>,
  field: string,
): Promise<string | null> {
  const body = MATERIAL_BODIES[kind].find((item) => item[0] === field);
  if (!body) throw new Error('material_body_field_invalid');
  const key = values[body[1]];
  if (key !== undefined && key !== null) {
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('material_body_digest_invalid');
    return key;
  }
  const value = values[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('material_body_text_invalid');
  return sha256Hex(value);
}
export { MATERIAL_COLUMNS as VIEW_COLUMNS } from '../db/view-tables.js';
/** Hashes complete logical content independently of storage locators and learning policy. */
export async function viewContentHash(kind: ViewKind, values: Record<string, unknown>): Promise<string> {
  const neutral = new Set([
    'blob_key',
    'input_blob_key',
    'output_blob_key',
    'received_at',
    'updated_at',
    'call_source',
    'outcome_source',
    'content_hash',
    'input_bytes',
    'source_tag',
    'source_coordinate',
    'tags_json',
    'prompt_key_hash',
  ]);
  const tags = values.tags ?? [];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) throw new Error('invalid_material_tags');
  const fields = kind === 'plan' ? [...VIEW_COLUMNS[kind], 'tags'] : VIEW_COLUMNS[kind];
  const bodies = new Set<string>(MATERIAL_BODIES[kind].map((body) => body[0]));
  const content = await Promise.all(
    fields
      .filter((key) => !neutral.has(key))
      .map(async (key) => [
        key,
        key === 'tags'
          ? [...new Set(tags)].sort()
          : bodies.has(key)
            ? await materialBodyDigest(kind, values, key)
            : nullable(values[key]),
      ]),
  );
  return sha256Hex(JSON.stringify([kind, content]));
}

/** Stored hook context hashes its admitted fields independently of its computed placement. */
export async function materialContentHash(kind: MaterialKind, values: Record<string, unknown>): Promise<string> {
  if (kind === 'prompt' || kind === 'response' || kind === 'tool' || kind === 'plan')
    return viewContentHash(kind, values);
  const jsonFields = new Set(['spore_ids', 'plan_ids', 'parts', 'skipped', 'failures', 'selection', 'payload']);
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  return sha256Hex(
    JSON.stringify([
      kind,
      CONTEXT_MATERIAL_COLUMNS[kind].map((field) => [
        field,
        jsonFields.has(field) && typeof values[field] === 'string'
          ? canonical(JSON.parse(values[field] as string))
          : nullable(values[field]),
      ]),
    ]),
  );
}
