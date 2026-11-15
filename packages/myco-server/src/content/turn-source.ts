import type { DocRecord } from './document.js';
import { sha256Hex, utf8 } from '../hash.js';

export type SourceSegment = { text: string; bytes: number } | { field: string; bytes: number };

/** One record's source segments; a stored body contributes its size without opening it. */
export function sourceSegments(record: DocRecord): SourceSegment[] {
  const bodies = record.bodies;
  const fields: Record<string, unknown> = { k: record.k, id: record.id };
  for (const field of CONTENT_FIELDS[record.k]) fields[field] = record[field] ?? null;
  const segments: SourceSegment[] = [];
  for (const [field, ref] of Object.entries(bodies ?? {})) fields[field] = { stored_body_bytes: ref.bytes };
  const header = `${JSON.stringify(fields)}\n`;
  segments.push({ text: header, bytes: utf8(header).length });
  for (const [field, ref] of Object.entries(bodies ?? {})) {
    const label = `\nBODY ${field}:\n`;
    segments.push({ text: label, bytes: utf8(label).length }, { field, bytes: ref.bytes });
  }
  return segments;
}

export const sourceBytes = (record: DocRecord) => sourceSegments(record).reduce((sum, segment) => sum + segment.bytes, 0);

const CONTENT_FIELDS = {
  prompt: ['origin', 'text', 'prompt_kind', 'thread_label'], reply: ['text'],
  tool: ['tool_name', 'input', 'output_preview', 'success', 'error_message', 'files_affected'],
  plan: ['title', 'status', 'content'],
} as const;

/** A record's content contribution, independent of capture identity and receipt metadata. */
export async function contentContribution(record: DocRecord): Promise<string> {
  const content: Record<string, unknown> = { kind: record.k };
  for (const field of CONTENT_FIELDS[record.k]) {
    const value = record[field];
    content[field] = record.bodies?.[field]?.digest ?? (typeof value === 'string' ? await sha256Hex(value) : value ?? null);
  }
  return sha256Hex(JSON.stringify(content));
}

/** Ordered content, or an ordered content change on a wider turn whose complete fingerprint is already held. */
export const contentFingerprint = (parts: readonly string[] | { previous: string; changes: readonly (readonly [string | null, string])[] }) => sha256Hex(JSON.stringify(parts));
