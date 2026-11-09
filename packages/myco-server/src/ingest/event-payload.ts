import { utf8 } from '../hash.js';

/**
 * Largest serialized event payload held in the events table; anything bigger lives in the object store. A full
 * archive bundle of inline rows (64 entries at this size) fills exactly one bundle byte page, so bundling never
 * splits a page of hot rows.
 */
export const EVENT_INLINE_PAYLOAD_BYTES = 16_384;

const RETAINED_FIELD_BYTES = 2_048;
const RETAINED_TOTAL_BYTES = 8_192;

/**
 * What a payload stored in the object store keeps in its row: every field small enough to be metadata, up to a fixed
 * total, smallest first. Identifiers and lifecycle fields always fit, so readers of those fields see what they would see
 * in the whole payload; only large text and structured values are left out.
 */
export function retainedEventPayload(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return '{}';
  const fields = Object.entries(payload as Record<string, unknown>)
    .map(([name, value]) => ({ name, value, bytes: utf8(JSON.stringify(value) ?? 'null').byteLength + utf8(name).byteLength + 4 }))
    .filter(field => field.bytes <= RETAINED_FIELD_BYTES)
    .sort((a, b) => a.bytes - b.bytes || (a.name < b.name ? -1 : 1));
  const kept: Record<string, unknown> = {};
  let total = 2;
  for (const field of fields) {
    if (total + field.bytes > RETAINED_TOTAL_BYTES) break;
    kept[field.name] = field.value;
    total += field.bytes;
  }
  return JSON.stringify(kept);
}
