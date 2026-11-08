import { DOCUMENT_TEXT_FIELDS } from './document-text.js';
import { MAX_BLOB_BYTES } from '../constants.js';

import { kindSpec, parsePayload, type KindSpec, type Bound } from './kinds.js';

import { boundDerivedEvent } from './parsers/bounds.js';

import type { PreparedStatement, RelationalStore } from '../core/adapters.js';

import type { DerivedEvent } from './parsers/index.js';

export type PublicationRefusal = 'kind_unsupported' | 'inline_body_required' | 'unpaired_surrogate' | 'payload_invalid';

/** Admission failures carry a content-free code independently of their diagnostic message. */
export class RecordRefused extends Error {
  constructor(readonly subreason: PublicationRefusal, message: string) {
    super(message);
    this.name = 'RecordRefused';
  }
}



/** The receipt-time read for source offsets a cache does not hold yet. */
function receiptRead(db: RelationalStore, project: string, transcript: string, missing: readonly number[]): PreparedStatement {
  return db
    .prepare(
      `SELECT j.value offset,COALESCE(
    (SELECT s.received_at FROM transcript_segments s WHERE s.project_id=? AND s.transcript_id=? AND s.base_offset<=j.value AND s.base_offset+s.length>j.value ORDER BY s.base_offset DESC LIMIT 1),
    (SELECT r.received_at FROM raw_archive_refs r WHERE r.project_id=? AND r.transcript_id=? AND r.source_kind='transcript' AND r.disposition='archived'
      AND r.base_offset<=j.value AND r.base_offset+r.length>j.value ORDER BY r.base_offset DESC LIMIT 1)) received_at FROM json_each(?) j`,
    )
    .bind(project, transcript, project, transcript, JSON.stringify(missing));
}




function heldReceipts(rows: readonly { offset: number; received_at: number | null }[], cache: Map<number, number>) {
  for (const row of rows) {
    if (row.received_at === null) throw new Error('view_source_receipt_absent');
    cache.set(row.offset, row.received_at);
  }
  return cache;
}




/** Original receipt times bound each source record independently of the rebuild clock. */
export async function sourceReceipts(
  db: RelationalStore,
  project: string,
  transcript: string,
  offsets: readonly number[],
  cache = new Map<number, number>(),
): Promise<Map<number, number>> {
  const missing = [...new Set(offsets)].filter((offset) => !cache.has(offset));
  if (!missing.length) return cache;
  const rows = (await receiptRead(db, project, transcript, missing).all<{ offset: number; received_at: number | null }>()).results;
  return heldReceipts(rows, cache);
}




/** Document bodies use verified blob admission; all other fields retain catalogue bounds. */
export function admittedDocumentEvent(event: DerivedEvent, now: number): DerivedEvent {
  const spec = kindSpec(event.kind), fields = DOCUMENT_TEXT_FIELDS[event.kind];
  if (!spec || fields === undefined) throw new RecordRefused('kind_unsupported', 'view_record_kind_unsupported');
  const bodies = Object.values(fields);
  if (event.payload.blob !== undefined || event.payload.outputBlob !== undefined)
    throw new RecordRefused('inline_body_required', 'view_record_refused: parser bodies require inline source content');
  const placeholder = { ...event.payload };
  for (const field of bodies)
    if (placeholder[field] !== undefined) placeholder[field] = typeof placeholder[field] === 'string' ? '' : {};
  const bounded = boundDerivedEvent({ ...event, payload: placeholder });
  const payload = { ...bounded.payload };
  for (const field of bodies) if (event.payload[field] !== undefined) payload[field] = event.payload[field];
  if (Object.values(payload).some((value) => typeof value === 'string' && /[\uD800-\uDFFF]/u.test(value)))
    throw new RecordRefused('unpaired_surrogate', 'view_record_refused: string contains an unpaired surrogate');
  const bound = (field: string, value: Bound): Bound =>
    !bodies.includes(field)
      ? value
      : value.type === 'string'
        ? { ...value, max: MAX_BLOB_BYTES }
        : value.type === 'json'
          ? { ...value, maxBytes: MAX_BLOB_BYTES }
          : value;
  const viewSpec: KindSpec = {
    ...spec,
    fields: Object.fromEntries(
      Object.entries(spec.fields).map(([field, value]) => [field, { ...value, bound: bound(field, value.bound) }]),
    ),
  };
  const admitted = parsePayload(viewSpec, payload, now);
  if (!admitted.ok) throw new RecordRefused('payload_invalid', 'view_record_refused: ' + admitted.reason);
  return { ...event, payload: admitted.value };
}
