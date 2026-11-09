/**
 * Moves large run bodies out of their rows, only after a verified copy.
 *
 * A body leaves its row in one fenced commit: it is written under a generation only this move holds, read back and hashed
 * against its size and digest, and only then does a batch that re-reads the exact row, the exact upload authority and the
 * exact registration clear the column, as its last statement. A refused commit changes nothing, and an upload it never
 * adopts goes to the object release owner. A reader of a moved body gets its verified bytes, or `RunBodyUnavailable`,
 * which the doors answer as a named, retryable outcome, never an empty body.
 */
import type { ContentStore } from '../../core/adapters.js';
import { blobObjectKey } from '../../core/blob-objects.js';
import { BLOB_RESERVATION_TTL_MS } from '../../constants.js';
import { sha256HexOf, utf8 } from '../../hash.js';
import { readVerifiedContentText, verifyContentObject } from '../../core/registered-content.js';
import { emit, classify } from '../../telemetry.js';
import { assertion, commit, read, readSet, refusalCode, refusalDetail, write, type Bound } from '../index.js';
import { consumeUpload } from '../storage/object-lifecycle.js';
import { bodyFailureHeld, clearBodyFailure, recordBodyFailure, type BodyIdentity, type RunBodyKind } from './body-failures.js';
import { REPORT_BODY_DUE, RUN_BODY_DUE, RUN_BODY_INLINE_BYTES, runNotRetiring } from './evidence-schema.js';
import { listReports, type ReportRow } from './evidence.js';
import { storedAudit } from '../../core/run-audit.js';
import type { ReadScope } from '../../read/scope.js';

export const RUN_BODY_UNAVAILABLE = 'run_body_unavailable';
/** A body settles for a day before it moves, so an attempt that is still being read never pays for a blob fetch. */
export const RUN_BODY_SETTLE_MS = 24 * 60 * 60 * 1000;
export const RUN_BODY_PAGE = 8;
const MOVE_TOKEN = 'run-body-move';
const BODY_MEDIA_TYPE = 'text/plain; charset=utf-8';

/** A body is moved and its copy cannot be read right now: never an empty answer. */
export class RunBodyUnavailable extends Error {
  readonly code = RUN_BODY_UNAVAILABLE;
  readonly retryable = true;
  constructor(readonly kind: string, readonly runId: string, cause?: unknown) {
    super(`the ${kind} of run ${runId} is stored in a blob that could not be read right now; try again shortly`, { cause });
  }
}

/** The run is gone or being retired: the doors answer this as not found. */
export class RunNotFound extends Error {
  constructor(readonly runId: string) { super(`run ${runId} not found`); }
}

interface DueBody extends BodyIdentity { body: string }

const dueInstructions = read<[cutoff: number, now: number, limit: number], { projectId: string; runId: string; body: string }>({ name: 'runs.bodyDueInstructions', sql:
  `SELECT project_id AS projectId, id AS runId, instruction AS body FROM agent_runs r INDEXED BY idx_agent_runs_body_due
   WHERE ${RUN_BODY_DUE} AND completed_at < ?1
     AND ${runNotRetiring('r.project_id', 'r.id')}
     AND NOT ${bodyFailureHeld('instruction', 'r.project_id', 'r.id', '0', '?2')}
   ORDER BY completed_at, project_id, id LIMIT ?3` });
const detailsHeld = bodyFailureHeld('report_details', 'r.project_id', 'r.run_id', 'r.id', '?2');
const auditHeld = bodyFailureHeld('report_audit', 'r.project_id', 'r.run_id', 'r.id', '?2');
const inlineSized = (column: string) => `length(CAST(${column} AS BLOB)) >= ${RUN_BODY_INLINE_BYTES}`;
type DueReport = { projectId: string; runId: string; item: number; details: string | null; audit: string | null; detailsHeld: number; auditHeld: number };
const dueReports = read<[cutoff: number, now: number, limit: number], DueReport>({ name: 'runs.bodyDueReports', sql:
  `SELECT project_id AS projectId, run_id AS runId, id AS item, details, audit, ${detailsHeld} AS detailsHeld, ${auditHeld} AS auditHeld
   FROM agent_reports r INDEXED BY idx_agent_reports_body_due
   WHERE (${REPORT_BODY_DUE}) AND created_at < ?1
     AND ${runNotRetiring('r.project_id', 'r.run_id')}
     AND ((details IS NOT NULL AND ${inlineSized('details')} AND NOT ${detailsHeld}) OR (audit IS NOT NULL AND ${inlineSized('audit')} AND NOT ${auditHeld}))
   ORDER BY created_at, id LIMIT ?3` });
const blobHeld = read<[project: string, key: string], { generation: string | null; size: number }>({ name: 'runs.bodyBlobHeld', sql:
  `SELECT generation, size FROM blobs WHERE project_id = ?1 AND key = ?2` });
const reserve = write<[upload: string, project: string, key: string, token: string, size: number, expires: number, source: string]>({ name: 'runs.bodyReserve', sql:
  `INSERT INTO blob_reservations (reservation_id, project_id, key, token_id, size, expires_at, authority_kind, source_kind, source_id)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'server', 'run-body', ?7)` });
const UPLOAD_REFUSED = refusalCode('run_body_upload_refused');
const REGISTRATION_REFUSED = refusalCode('run_body_registration_refused');
const SOURCE_CHANGED = refusalCode('run_body_source_changed');
const reservationHeld = assertion<[upload: string, project: string, key: string, size: number, now: number]>({ name: 'runs.bodyReservationHeld', refusal: UPLOAD_REFUSED, when:
  `EXISTS (SELECT 1 FROM blob_reservations WHERE reservation_id = ?1 AND project_id = ?2 AND key = ?3 AND size = ?4 AND expires_at > ?5 AND authority_kind = 'server')` });
const registerBody = write<[project: string, key: string, size: number, media: string, token: string, at: number, generation: string]>({ name: 'runs.bodyRegister', sql:
  `INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (project_id, key) DO NOTHING` });
const registrationHeld = assertion<[project: string, key: string, generation: string | null, size: number]>({ name: 'runs.bodyRegistrationHeld', refusal: REGISTRATION_REFUSED, when:
  `EXISTS (SELECT 1 FROM blobs WHERE project_id = ?1 AND key = ?2 AND generation IS ?3 AND size = ?4)` });
const releaseReservation = write<[upload: string]>({ name: 'runs.bodyReleaseReservation', sql: `DELETE FROM blob_reservations WHERE reservation_id = ?1` });
const insertRef = write<[project: string, run: string, kind: string, item: number, key: string, size: number, at: number]>({ name: 'runs.bodyRef', sql:
  `INSERT INTO run_bodies (project_id, run_id, body_kind, item_id, key, size, moved_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)` });

const runStillDue = assertion<[project: string, run: string, body: string]>({ name: 'runs.bodyInstructionDue', refusal: SOURCE_CHANGED, when:
  `EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ?1 AND id = ?2 AND status IN ('completed','failed','skipped') AND resumable = 0 AND instruction = ?3)` });
const clearInstruction = write<[project: string, run: string, body: string], { id: string }>({ name: 'runs.bodyClearInstruction', sql:
  `UPDATE agent_runs SET instruction = NULL WHERE project_id = ?1 AND id = ?2 AND status IN ('completed','failed','skipped') AND resumable = 0 AND instruction = ?3 RETURNING id` });
type ReportParams = [project: string, run: string, item: number, body: string];
const reportStillDue = (column: 'details' | 'audit') => assertion<ReportParams>({ name: `runs.body${column === 'details' ? 'Details' : 'Audit'}Due`, refusal: SOURCE_CHANGED, when:
  `EXISTS (SELECT 1 FROM agent_reports WHERE project_id = ?1 AND run_id = ?2 AND id = ?3 AND ${column} = ?4)` });
const clearReport = (column: 'details' | 'audit') => write<ReportParams, { id: number }>({ name: `runs.bodyClear${column === 'details' ? 'Details' : 'Audit'}`, sql:
  `UPDATE agent_reports SET ${column} = NULL WHERE project_id = ?1 AND run_id = ?2 AND id = ?3 AND ${column} = ?4 RETURNING id` });
const reportClears = { report_details: { due: reportStillDue('details'), clear: clearReport('details') }, report_audit: { due: reportStillDue('audit'), clear: clearReport('audit') } };

const sourceDue = (due: DueBody): Bound => due.kind === 'instruction'
  ? runStillDue.bind(due.projectId, due.runId, due.body)
  : reportClears[due.kind].due.bind(due.projectId, due.runId, due.item, due.body);
const sourceClear = (due: DueBody): Bound<{ id: unknown }> => due.kind === 'instruction'
  ? clearInstruction.bind(due.projectId, due.runId, due.body)
  : reportClears[due.kind].clear.bind(due.projectId, due.runId, due.item, due.body);

/**
 * Move one body: copy, verify, then a fenced commit whose statements all name this object's exact identity, the
 * registration and the source row still holding the bytes that were copied, with the clear last.
 */
async function moveBody(env: ContentStore, due: DueBody, now: number): Promise<void> {
  const bytes = utf8(due.body);
  if (new TextDecoder().decode(bytes) !== due.body) throw new Error('run_body_not_text');
  const digest = await sha256HexOf(bytes);
  const [[existing]] = await readSet(env.db, blobHeld.bind(due.projectId, digest));
  if (existing !== undefined && existing.size !== bytes.byteLength) throw new Error('run_body_blob_size_conflict');
  let upload: string | null = null;
  let generation = existing?.generation ?? null;
  let committed = false;
  try {
    if (existing === undefined) {
      upload = crypto.randomUUID();
      generation = upload;
      await commit(env.db, reserve.bind(upload, due.projectId, digest, MOVE_TOKEN, bytes.byteLength, now + BLOB_RESERVATION_TTL_MS, `${due.runId}/${due.kind}/${due.item}`));
      const stored = await env.blobs.put(blobObjectKey(due.projectId, digest, upload),
        new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
        { size: bytes.byteLength, sha256: digest, httpMetadata: { contentType: BODY_MEDIA_TYPE } });
      if (stored.durable !== true || stored.size !== bytes.byteLength) throw new Error('run_body_upload_unverified');
    }
    await verifyContentObject(env, blobObjectKey(due.projectId, digest, generation), bytes.byteLength, digest);
    const adoption: Bound[] = upload === null ? [] : [
      reservationHeld.bind(upload, due.projectId, digest, bytes.byteLength, Date.now()),
      registerBody.bind(due.projectId, digest, bytes.byteLength, BODY_MEDIA_TYPE, MOVE_TOKEN, now, upload),
    ];
    const results = await commit(env.db, sourceDue(due), ...adoption,
      registrationHeld.bind(due.projectId, digest, generation, bytes.byteLength),
      ...(upload === null ? [] : [releaseReservation.bind(upload)]),
      insertRef.bind(due.projectId, due.runId, due.kind, due.item, digest, bytes.byteLength, now),
      clearBodyFailure.bind(due.projectId, due.runId, due.kind, due.item),
      sourceClear(due));
    if (results.at(-1)?.results.length !== 1) throw new Error(SOURCE_CHANGED);
    committed = true;
  } finally {
    if (upload !== null && !committed) await consumeUpload(env.db, upload, now);
  }
}

const MOVE_REFUSALS = [UPLOAD_REFUSED, REGISTRATION_REFUSED, SOURCE_CHANGED];
const MOVE_STOPS: readonly string[] = ['run_body_not_text', 'run_body_blob_size_conflict', 'run_body_upload_unverified', SOURCE_CHANGED];

/** The name a move failed under: a refusal from its commit, one of its own stops, or what the store classifies. */
function moveFailure(error: unknown): string {
  const refusal = MOVE_REFUSALS.find((code) => refusalDetail(error, code) !== null);
  if (refusal !== undefined) return refusal;
  return error instanceof Error && MOVE_STOPS.includes(error.message) ? error.message : classify(error);
}

const dueBodies = (report: DueReport): DueBody[] => {
  const identity = { projectId: report.projectId, runId: report.runId, item: report.item };
  const of = (kind: RunBodyKind, body: string | null, held: number): DueBody[] =>
    body !== null && Number(held) === 0 && utf8(body).byteLength >= RUN_BODY_INLINE_BYTES ? [{ ...identity, kind, body }] : [];
  return [...of('report_details', report.details, report.detailsHeld), ...of('report_audit', report.audit, report.auditHeld)];
};

/**
 * Moves one page of settled bodies. A body that cannot move is marked and left on its row, named in telemetry, and
 * skipped until its backoff passes, so it never holds the bodies behind it; the pass stops when a page comes back short.
 */
export async function moveRunBodies(env: ContentStore, now: number, page = RUN_BODY_PAGE): Promise<{ changed: number; more: boolean }> {
  const cutoff = now - RUN_BODY_SETTLE_MS;
  const [runs, reports] = await readSet(env.db, dueInstructions.bind(cutoff, now, page), dueReports.bind(cutoff, now, page));
  const due: DueBody[] = [
    ...runs.map((row): DueBody => ({ kind: 'instruction', projectId: row.projectId, runId: row.runId, item: 0, body: row.body })),
    ...reports.flatMap(dueBodies),
  ];
  let changed = 0, unmarked = false;
  for (const body of due) {
    try { await moveBody(env, body, now); changed++; }
    catch (error) {
      const failure = moveFailure(error);
      const failures = await recordBodyFailure(env.db, body, failure, now).catch((marking: unknown) => {
        unmarked = true;
        emit({ kind: 'run_body_failure_unrecorded', projectId: body.projectId, runId: body.runId, bodyKind: body.kind, item: body.item, error_class: classify(marking) });
        return null;
      });
      emit({ kind: 'run_body_move_failed', projectId: body.projectId, runId: body.runId, bodyKind: body.kind, item: body.item, error: failure, failures });
    }
  }
  return { changed, more: !unmarked && (runs.length === page || reports.length === page) };
}

const bodyRef = read<[project: string, run: string, kind: string, item: number], { key: string | null; size: number | null; generation: string | null }>({ name: 'runs.bodyRead', sql:
  `SELECT b.key, b.size, bl.generation FROM agent_runs r
   LEFT JOIN run_bodies b ON b.project_id = r.project_id AND b.run_id = r.id AND b.body_kind = ?3 AND b.item_id = ?4
   LEFT JOIN blobs bl ON bl.project_id = b.project_id AND bl.key = b.key
   WHERE r.project_id = ?1 AND r.id = ?2 AND ${runNotRetiring('r.project_id', 'r.id')}` });

async function resolveBody(env: ContentStore, scope: ReadScope, runId: string, kind: RunBodyKind, item: number): Promise<string | null> {
  const [[ref]] = await readSet(env.db, bodyRef.bind(scope.projectId, runId, kind, item));
  if (ref === undefined) throw new RunNotFound(runId);
  if (ref.key === null) return null;
  try {
    return await readVerifiedContentText(env, blobObjectKey(scope.projectId, ref.key, ref.generation), ref.size ?? 0, ref.key);
  } catch (error) { throw new RunBodyUnavailable(kind, runId, error); }
}

/** A run's instruction resolved through its verified copy; null means the run holds no instruction. */
export async function runInstructionBody(env: ContentStore, scope: ReadScope, runId: string): Promise<string | null> {
  return resolveBody(env, scope, runId, 'instruction', 0);
}

/** A run's latest reports with every moved body resolved through its verified copy, and whether it holds more than are listed. */
export async function listReportsWithBodies(env: ContentStore, scope: ReadScope, runId: string): Promise<{ reports: ReportRow[]; hasMore: boolean }> {
  const { reports, hasMore } = await listReports(env.db, scope, runId);
  return { hasMore, reports: await Promise.all(reports.map(async (report) => {
    const details = report.detailsMoved ? await resolveBody(env, scope, runId, 'report_details', report.id) : report.details;
    const audit = report.auditMoved ? storedAudit(await resolveBody(env, scope, runId, 'report_audit', report.id)) : report.audit;
    return { ...report, details, audit };
  })) };
}
