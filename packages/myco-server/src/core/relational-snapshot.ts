import { isArchivedEventMetadata } from '../db/document-tables.js';
import type { ContentStore, RelationalStore } from './adapters.js';
import { bundleContentEnv, readBundleEntry } from './archive-bundle.js';
import { snapshotAdmission, snapshotColumns, snapshotLines, snapshotRowCount, type SnapshotAdmission } from '../db/recovery/relational-snapshot.js';

type Row = Record<string, unknown>;

export class RelationalSnapshotError extends Error {}
export class RelationalSnapshotTooLargeError extends RelationalSnapshotError {
  constructor(readonly bytes: number) { super(`the relational snapshot needs ${bytes} bytes`); }
}

const MAX_RELATIONAL_SNAPSHOT_ROWS = 10_000;
const MAX_RELATIONAL_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const OPERATOR_BACKUP = 'myco server backup --to <directory> --target <deployment-target>';

export class RelationalSnapshotAdmissionError extends RelationalSnapshotError {
  constructor(readonly rows: number, readonly conservativeBytes: number | null) {
    super(`the additive snapshot needs ${rows} rows${conservativeBytes === null ? '' : ` and at most ${conservativeBytes} conservative bytes`}; its admission limits are ${MAX_RELATIONAL_SNAPSHOT_ROWS} rows and ${MAX_RELATIONAL_SNAPSHOT_BYTES} conservative bytes. Use ${OPERATOR_BACKUP} for full operator recovery`);
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Count admission precedes payload reads; the snapshot repeats admission at its committed instant. */
export async function relationalSnapshot(db: RelationalStore, tables: readonly string[], maxBytes: number): Promise<ReadonlyMap<string, readonly Row[]>> {
  if (tables.length === 0 || !tables.every((table) => IDENTIFIER.test(table))) throw new RelationalSnapshotError('snapshot tables must be store identifiers');
  const count = await snapshotRowCount(db, tables);
  if (typeof count !== 'number') throw new RelationalSnapshotError('the snapshot returned no admission count');
  if (count > MAX_RELATIONAL_SNAPSHOT_ROWS) throw new RelationalSnapshotAdmissionError(count, null);
  const columns = await snapshotColumns(db, tables);
  const names = tables.map((table, index) => {
    const fields = columns[index]!;
    if (fields.length === 0 || !fields.every((name) => IDENTIFIER.test(name))) throw new RelationalSnapshotError(`the snapshot table ${table} has no readable schema`);
    return fields;
  });
  const byteLimit = Math.min(maxBytes, MAX_RELATIONAL_SNAPSHOT_BYTES);
  const admit = (receipt: SnapshotAdmission | undefined) => {
    if (receipt === undefined || typeof receipt.admission_count !== 'number') throw new RelationalSnapshotError('the snapshot returned no admission receipt');
    if (receipt.admission_count > MAX_RELATIONAL_SNAPSHOT_ROWS) throw new RelationalSnapshotAdmissionError(receipt.admission_count, null);
    if (typeof receipt.admission_bytes !== 'number') throw new RelationalSnapshotError('the snapshot returned no admission size');
    if (receipt.admission_bytes > MAX_RELATIONAL_SNAPSHOT_BYTES) throw new RelationalSnapshotAdmissionError(receipt.admission_count, receipt.admission_bytes);
    if (receipt.admission_bytes > maxBytes) throw new RelationalSnapshotTooLargeError(receipt.admission_bytes);
  };
  admit(await snapshotAdmission(db, tables, names, MAX_RELATIONAL_SNAPSHOT_ROWS));
  const rows = await snapshotLines(db, tables, names, MAX_RELATIONAL_SNAPSHOT_ROWS, byteLimit);
  admit(rows[0]);
  const measured = rows[0];
  if (measured === undefined) throw new RelationalSnapshotError('the snapshot returned no completeness receipt; no artifact was published');
  if (measured.snapshot_bytes > maxBytes) throw new RelationalSnapshotTooLargeError(measured.snapshot_bytes);
  const lines = rows.filter((row) => row.line !== null);
  if (measured.snapshot_count !== lines.length) throw new RelationalSnapshotError('the snapshot is incomplete; no artifact was published');
  const snapshot = new Map<string, Row[]>(tables.map((table) => [table, []]));
  for (const row of lines) {
    const parsed = JSON.parse(row.line!) as { t: string; r: Row };
    snapshot.get(parsed.t)!.push(parsed.r);
  }
  return snapshot;
}

const SESSION_CHILDREN = ['events', 'archive_bundles', 'raw_archive_refs', 'plans', 'attachments', 'transcripts', 'session_artifacts'];
const identity = (row: Row, key: string) => JSON.stringify([row.project_id, row[key]]);

/** A snapshot must carry the registered bytes and evidence for every archived event. */
export function assertArchivedContentClosure(snapshot: ReadonlyMap<string, readonly Row[]>): void {
  const eventRows = snapshot.get('events') ?? [];
  const events = new Map(eventRows.map((row) => [identity(row, 'event_id'), row]));
  if (events.size !== eventRows.length) {
    throw new RelationalSnapshotError('the snapshot repeats an archived content identity; no artifact was published');
  }
  const bundleRows = snapshot.get('archive_bundles') ?? [];
  const bundles = new Map(bundleRows.map(row => [identity(row, 'id'), row]));
  if (bundles.size !== bundleRows.length) throw new RelationalSnapshotError('the snapshot repeats an archive bundle identity; no artifact was published');
  const blobs = new Map((snapshot.get('blobs') ?? []).map((row) => [identity(row, 'key'), row]));
  const proofs = snapshot.get('registered_content_proofs') ?? [];
  const bundleOf = (row: Row, bundleId: unknown, entry: unknown): Row => {
    const bundle = bundles.get(JSON.stringify([row.project_id, bundleId]));
    if (bundle === undefined || bundle.session_id !== row.session_id || bundle.token_id !== row.token_id
      || !Number.isSafeInteger(entry) || (entry as number) < 0 || (entry as number) >= (bundle.entry_count as number)) {
      throw new RelationalSnapshotError('the snapshot has a content locator outside its source bundle; no artifact was published');
    }
    return bundle;
  };
  for (const event of events.values()) {
    if (event.payload_format === 'archived') {
      if (!isArchivedEventMetadata(event.payload) || !Number.isSafeInteger(event.bundle_id)) {
        throw new RelationalSnapshotError('the snapshot of events lacks an archived content locator; no artifact was published');
      }
      bundleOf(event, event.bundle_id, event.bundle_entry);
    }
  }
  for (const bundle of bundleRows) {
    if (bundle.version !== 1 || bundle.digest !== bundle.archive_key || !Number.isSafeInteger(bundle.size)
      || !Number.isSafeInteger(bundle.entry_count) || (bundle.entry_count as number) < 1) {
      throw new RelationalSnapshotError('the snapshot has an invalid archive bundle; no artifact was published');
    }
    const anchor = events.get(JSON.stringify([bundle.project_id,bundle.event_id]));
    if (anchor === undefined || anchor.session_id !== bundle.session_id || anchor.token_id !== bundle.token_id
      || anchor.envelope_hash !== bundle.envelope_hash) {
      throw new RelationalSnapshotError('the snapshot of archive_bundles lacks its source event; no artifact was published');
    }
    for (const key of [bundle.archive_key, bundle.receipt_key]) {
      if (typeof key !== 'string' || !blobs.has(JSON.stringify([bundle.project_id, key]))) {
        throw new RelationalSnapshotError('the snapshot of archive_bundles lacks a registered object; no artifact was published');
      }
      if (!proofs.some((proof) => proof.project_id === bundle.project_id && proof.key === key
        && proof.event_id === bundle.event_id && proof.session_id === bundle.session_id
        && proof.envelope_hash === bundle.envelope_hash && proof.digest === key && proof.durable === 1
        && (key === bundle.archive_key
          ? proof.source_kind === 'bundle' && proof.source_id === bundle.archive_key
          : proof.source_kind === 'receipt' && proof.source_id === `bundle:${String(bundle.archive_key)}`)
        && (key !== bundle.archive_key || proof.size === bundle.size))) {
        throw new RelationalSnapshotError('the snapshot of archive_bundles lacks a verified body or receipt proof; no artifact was published');
      }
    }
  }
  for (const proof of proofs) {
    const blob = blobs.get(JSON.stringify([proof.project_id, proof.key]));
    if (blob === undefined || blob.generation !== proof.generation || blob.key !== proof.digest || blob.size !== proof.size) {
      throw new RelationalSnapshotError('the snapshot of registered_content_proofs disagrees with its blob; no artifact was published');
    }
  }
  for (const ref of snapshot.get('raw_archive_refs') ?? []) {
    if (ref.disposition !== 'archived') continue;
    if (ref.digest !== ref.archive_key) {
      throw new RelationalSnapshotError('the snapshot of raw_archive_refs disagrees with its archive digest; no artifact was published');
    }
    for (const key of [ref.archive_key, ref.receipt_key]) {
      if (typeof key !== 'string' || !blobs.has(JSON.stringify([ref.project_id, key]))) {
        throw new RelationalSnapshotError('the snapshot of raw_archive_refs lacks a registered object; no artifact was published');
      }
    }
    const body = proofs.some(proof => proof.project_id === ref.project_id && proof.key === ref.archive_key
      && proof.source_kind === ref.source_kind && proof.source_id === ref.source_id
      && proof.session_id === ref.session_id && proof.digest === ref.archive_key && proof.size === ref.size && proof.durable === 1);
    const receipt = proofs.some(proof => proof.project_id === ref.project_id && proof.key === ref.receipt_key
      && proof.source_kind === 'receipt' && proof.source_id === `${ref.source_kind}:${ref.source_id}`
      && proof.session_id === ref.session_id && proof.digest === ref.receipt_key && proof.durable === 1);
    if (!body || !receipt) {
      throw new RelationalSnapshotError('the snapshot of raw_archive_refs lacks verified body or receipt; no artifact was published');
    }
  }
}

/** A relationally closed snapshot must also resolve each exact entry in its proved objects. */
export async function assertBundleObjectClosure(env: ContentStore, snapshot: ReadonlyMap<string, readonly Row[]>): Promise<void> {
  const reader = bundleContentEnv(env);
  for (const event of snapshot.get('events') ?? []) {
    if (event.payload_format !== 'archived') continue;
    await readBundleEntry(reader,{projectId:event.project_id as string,bundleId:event.bundle_id as number,
      entry:event.bundle_entry as number,kind:'event',resourceId:event.event_id as string,
      eventId:event.event_id as string,envelopeHash:event.envelope_hash as string,tokenId:event.token_id as string});
  }
}

/** Every capture row requires the session through which the Deployment reads it. */
export function assertCaptureClosure(snapshot: ReadonlyMap<string, readonly Row[]>): void {
  const sessions = new Set((snapshot.get('sessions') ?? []).map((row) => identity(row, 'session_id')));
  for (const table of SESSION_CHILDREN) {
    if ((snapshot.get(table) ?? []).some((row) => !sessions.has(identity(row, 'session_id')))) {
      throw new RelationalSnapshotError(`the snapshot of ${table} names a missing session; no artifact was published`);
    }
  }
  const transcripts = new Set((snapshot.get('transcripts') ?? []).map((row) => identity(row, 'transcript_id')));
  for (const table of ['transcript_segments']) {
    if ((snapshot.get(table) ?? []).some((row) => !transcripts.has(identity(row, 'transcript_id')))) {
      throw new RelationalSnapshotError(`the snapshot of ${table} names a missing transcript; no artifact was published`);
    }
  }
  assertArchivedContentClosure(snapshot);
}
