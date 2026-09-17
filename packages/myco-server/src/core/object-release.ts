/**
 * The one owner of stored-object deletion.
 *
 * A caller never deletes stored bytes. It *releases* them: one transaction decides, from the rows as they stand, which
 * objects nothing registers any more, records each by its physical key in `object_releases`, and removes the row that
 * registered it. The drain is the only code that asks the store to delete, and it removes a journal row only once the
 * store acknowledged that delete.
 *
 * No timing is involved: a physical key is written once. An upload stores under its own generation
 * (`core/blob-objects.ts`), a backup under its own id, a restore under its own generation. A delete that lands late,
 * twice, or from a replaced instance can only remove bytes already released, never bytes a later write
 * stored under the same content.
 *
 * A deletion records what it may have freed as release candidates, in the transaction that removes the rows naming it;
 * a decision then journals what nothing references. While a recovery hold is open nothing registered is journaled: the
 * candidates stay recorded, and a decision after the hold judges them against the rows as they stand then. Unregistered upload bytes are never in a snapshot, so their
 * journal is not held.
 */
import type { PreparedStatement, RelationalStore, ServerEnv } from './adapters.js';
import { BLOB_REFERENCES, blobHeld, type BlobRef } from './blob-references.js';
import { blobObjectKeySql } from './blob-objects.js';
import { within } from './recovery-inventory.js';
import { backupRetentionPolicy, currentRetentionVictims } from './backup-retention.js';
import { classify, emit } from '../telemetry.js';

/** SQL true while a recovery hold is open. */
export const HOLD_OPEN = 'EXISTS (SELECT 1 FROM recovery_holds WHERE released_at IS NULL)';

/** Candidates one release statement judges, bound as one JSON parameter. */
export const RELEASE_PAGE = 64;
/** Journal rows, expired authorities and deferred candidates one drain pass takes, each. */
export const DRAIN_PAGE = 16;
/** How long one store delete may take before the drain leaves its journal row for the next pass. */
export const DRAIN_DELETE_MS = 15_000;

const blobPage = `(SELECT json_extract(j.value, '$.p') AS p, json_extract(j.value, '$.k') AS k FROM json_each(?) j)`;
const idPage = `(SELECT j.value AS id FROM json_each(?) j)`;
const registeredPhysical = (alias: string) => blobObjectKeySql(`${alias}.project_id`, `${alias}.key`, `${alias}.generation`);

/** The physical key of the upload a reservation authorizes, over a `blob_reservations` alias. */
const reservedPhysical = (alias: string) => blobObjectKeySql(`${alias}.project_id`, `${alias}.key`, `${alias}.reservation_id`);

/**
 * Statements that consume one upload's authority: its bytes are journaled, and the reservation removed, in the batch
 * that carries them. A reservation already consumed journals nothing: whichever consumer committed first owns it.
 */
export function consumeUploadAuthority(db: RelationalStore, reservationId: string, now: number): PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO object_releases (physical, kind, created_at)
                  SELECT ${reservedPhysical('r')}, 'upload', ? FROM blob_reservations r WHERE r.reservation_id = ?
                  ON CONFLICT (physical) DO NOTHING`).bind(now, reservationId),
    db.prepare(`DELETE FROM blob_reservations WHERE reservation_id = ?`).bind(reservationId),
  ];
}

/**
 * Statements that consume every expired authority a selection names, journaling each one's bytes. `where` is SQL over
 * `blob_reservations` columns and binds `params`; the same selection is read by both statements of one transaction.
 */
export function consumeExpiredAuthorities(db: RelationalStore, where: string, params: readonly unknown[], now: number): PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO object_releases (physical, kind, created_at)
                  SELECT ${reservedPhysical('r')}, 'upload', ? FROM blob_reservations r
                   WHERE r.reservation_id IN (SELECT reservation_id FROM blob_reservations WHERE ${where})
                  ON CONFLICT (physical) DO NOTHING`).bind(now, ...params),
    db.prepare(`DELETE FROM blob_reservations WHERE reservation_id IN (SELECT reservation_id FROM blob_reservations WHERE ${where})`).bind(...params),
  ];
}

export interface ReleaseOutcome {
  /** Registered objects journaled for deletion, their rows removed. */
  released: number;
  /** Candidates an open hold keeps, recorded for a decision after it. */
  deferred: number;
}

/** A page of blob pairs as the one JSON parameter the release statements bind. */
const blobPageOf = (pairs: readonly BlobRef[]): string => JSON.stringify(pairs.map((b) => ({ p: b.projectId, k: b.key })));

/**
 * Statements that record `pairs` as blob release candidates, one per page, for the batch that removes the rows naming
 * them. Recorded in that same transaction, a candidate outlives any interruption before it is decided: the drain
 * decides what a caller did not.
 */
export function recordBlobCandidates(db: RelationalStore, pairs: readonly BlobRef[], now: number): PreparedStatement[] {
  const statements: PreparedStatement[] = [];
  for (let at = 0; at < pairs.length; at += RELEASE_PAGE) {
    statements.push(db.prepare(`INSERT INTO blob_release_candidates (project_id, key, created_at)
                                  SELECT c.p, c.k, ? FROM ${blobPage} c WHERE c.k IS NOT NULL
                                  ON CONFLICT (project_id, key) DO NOTHING`).bind(now, blobPageOf(pairs.slice(at, at + RELEASE_PAGE))));
  }
  return statements;
}

/**
 * Records `pairs` as candidates and decides them, one transaction per page:
 * - with no hold open, journal the exact object each registered, unreferenced candidate registered, remove exactly the
 *   rows whose own object is journaled — the match is on the physical key, so a journal row can never remove a row of
 *   another generation — and remove every candidate of the page, released or still referenced;
 * - with a hold open, the candidates stay recorded, and nothing else changes.
 *
 * A reference committed first holds its blob here; a reference arriving after is refused by the admission every
 * reference writer carries: the row is gone.
 */
export async function releaseBlobs(db: RelationalStore, pairs: readonly BlobRef[], now: number): Promise<ReleaseOutcome> {
  const outcome: ReleaseOutcome = { released: 0, deferred: 0 };
  for (let at = 0; at < pairs.length; at += RELEASE_PAGE) {
    const page = blobPageOf(pairs.slice(at, at + RELEASE_PAGE));
    const results = await db.batch([...recordBlobCandidates(db, pairs.slice(at, at + RELEASE_PAGE), now), ...blobDecisionStatements(db, page, now)]);
    outcome.released += results[1]!.meta.changes;
    outcome.deferred += (results[results.length - 1]!.results[0] as { held: number }).held;
  }
  return outcome;
}

/** The statements that decide a page of recorded blob candidates, ending with the count of the page's candidates still held. */
function blobDecisionStatements(db: RelationalStore, page: string, now: number): PreparedStatement[] {
  const candidate = (alias: string) => `EXISTS (SELECT 1 FROM blob_release_candidates rc WHERE rc.project_id = ${alias}.project_id AND rc.key = ${alias}.key)`;
  return [
    db.prepare(`INSERT INTO object_releases (physical, kind, created_at)
                  SELECT ${registeredPhysical('b')}, 'blob', ? FROM ${blobPage} c
                    JOIN blobs b ON b.project_id = c.p AND b.key = c.k
                   WHERE NOT ${HOLD_OPEN} AND ${candidate('b')} AND NOT (${blobHeld('c.p', 'c.k')})
                  ON CONFLICT (physical) DO NOTHING`).bind(now, page),
    db.prepare(`DELETE FROM blobs
                 WHERE EXISTS (SELECT 1 FROM ${blobPage} c WHERE c.p = blobs.project_id AND c.k = blobs.key)
                   AND EXISTS (SELECT 1 FROM object_releases r WHERE r.physical = ${registeredPhysical('blobs')})`).bind(page),
    db.prepare(`DELETE FROM blob_release_candidates
                 WHERE NOT ${HOLD_OPEN}
                   AND EXISTS (SELECT 1 FROM ${blobPage} c WHERE c.p = blob_release_candidates.project_id AND c.k = blob_release_candidates.key)`).bind(page),
    db.prepare(`SELECT COUNT(*) AS held FROM blob_release_candidates rc
                 WHERE EXISTS (SELECT 1 FROM ${blobPage} c WHERE c.p = rc.project_id AND c.k = rc.key)`).bind(page),
  ];
}

/**
 * Records catalogued backups as release candidates and decides them, one transaction per page. With no hold open, each
 * candidate among `victims` — the ids the retention owner (`core/backup-retention.ts`) lets go of under the policy in
 * force — that is still unpinned has its object journaled and its row removed, and every candidate of the page is
 * removed. With a hold open the candidates stay recorded for the drain, which asks the retention owner again.
 */
export async function releaseBackups(db: RelationalStore, ids: readonly string[], victims: ReadonlySet<string>, now: number): Promise<ReleaseOutcome> {
  const outcome: ReleaseOutcome = { released: 0, deferred: 0 };
  for (let at = 0; at < ids.length; at += RELEASE_PAGE) {
    const page = JSON.stringify(ids.slice(at, at + RELEASE_PAGE));
    const results = await db.batch([
      db.prepare(`INSERT INTO backup_release_candidates (id, created_at) SELECT p.id, ? FROM ${idPage} p WHERE p.id IS NOT NULL ON CONFLICT (id) DO NOTHING`).bind(now, page),
      ...backupDecisionStatements(db, page, victims, now),
    ]);
    outcome.released += results[1]!.meta.changes;
    outcome.deferred += (results[results.length - 1]!.results[0] as { held: number }).held;
  }
  return outcome;
}

function backupDecisionStatements(db: RelationalStore, page: string, victims: ReadonlySet<string>, now: number): PreparedStatement[] {
  const victimPage = JSON.stringify([...victims]);
  return [
    db.prepare(`INSERT INTO object_releases (physical, kind, created_at)
                  SELECT bk.key, 'backup', ? FROM backups bk
                   WHERE bk.id IN ${idPage} AND bk.id IN (SELECT j.value FROM json_each(?) j) AND bk.pinned = 0 AND NOT ${HOLD_OPEN}
                     AND EXISTS (SELECT 1 FROM backup_release_candidates rc WHERE rc.id = bk.id)
                  ON CONFLICT (physical) DO NOTHING`).bind(now, page, victimPage),
    db.prepare(`DELETE FROM backups
                 WHERE id IN ${idPage} AND EXISTS (SELECT 1 FROM object_releases r WHERE r.physical = backups.key)`).bind(page),
    db.prepare(`DELETE FROM backup_release_candidates WHERE NOT ${HOLD_OPEN} AND id IN ${idPage}`).bind(page),
    db.prepare(`SELECT COUNT(*) AS held FROM backup_release_candidates WHERE id IN ${idPage}`).bind(page),
  ];
}

/** The pairs among `pairs` no `blobs` row registers, each judged in its own Project. */
export async function unregisteredAmong(db: RelationalStore, pairs: readonly BlobRef[]): Promise<BlobRef[]> {
  const out: BlobRef[] = [];
  for (let at = 0; at < pairs.length; at += RELEASE_PAGE) {
    const page = JSON.stringify(pairs.slice(at, at + RELEASE_PAGE).map((b) => ({ p: b.projectId, k: b.key })));
    const { results } = await db
      .prepare(`SELECT c.p, c.k FROM ${blobPage} c WHERE NOT EXISTS (SELECT 1 FROM blobs b WHERE b.project_id = c.p AND b.key = c.k)`)
      .bind(page).all<{ p: string; k: string }>();
    out.push(...results.map((row) => ({ projectId: row.p, key: row.k })));
  }
  return out;
}

/** The blobs a row of `table` names through the reference catalogue, as the rows it carries state them. */
export function referencedBlobsOf(table: string, row: Readonly<Record<string, unknown>>): BlobRef[] {
  const projectId = row.project_id;
  if (typeof projectId !== 'string') return [];
  return BLOB_REFERENCES.filter((ref) => ref.table === table
    && typeof row[ref.column] === 'string'
    && (ref.kinds === undefined || ref.kinds.includes(row.kind as string)))
    .map((ref) => ({ projectId, key: row[ref.column] as string }));
}

/**
 * A statement that aborts its transaction when any pair names a blob no row registers. Placed first in the batch that
 * writes the rows naming them, it makes the registration check and those writes one transaction: a release that
 * commits first fails the batch, and one that commits after sees the new references and keeps the blob.
 */
export function registeredBlobsGuard(db: RelationalStore, pairs: readonly BlobRef[]): PreparedStatement {
  return db.prepare(`INSERT INTO restore_reference_guard (missing)
                       SELECT c.k FROM ${blobPage} c
                        WHERE NOT EXISTS (SELECT 1 FROM blobs b WHERE b.project_id = c.p AND b.key = c.k)`)
    .bind(JSON.stringify(pairs.map((b) => ({ p: b.projectId, k: b.key }))));
}

/** Who took a hold: this Deployment's own export producer, or an operator's full backup. */
export type RecoveryHoldHolder = 'producer' | 'operator';
/** Why an operator released its hold: the artifact completed, or the operator gave it up. */
export type OperatorHoldRelease = 'complete' | 'abandoned';

/** A hold row as an inspection reads it. */
export interface RecoveryHoldRow {
  token: string;
  holder: RecoveryHoldHolder;
  acquiredAt: number;
  releasedAt: number | null;
  releaseReason: string | null;
}

/**
 * Every statement of a hold's lifecycle, rendered here and nowhere else, so both targets and both holders transition a
 * hold the same way. A hosted operator sends these through the provider's own command path, which binds no parameters,
 * so the values are rendered into the statement: a token is a UUID, a holder and a reason are from closed sets, and an
 * instant is a number. Anything else is refused before a statement exists.
 */
export const recoveryHoldSql = {
  acquire(held: string, now: number, holder: RecoveryHoldHolder): string {
    return `INSERT INTO recovery_holds (token, acquired_at, holder)
              SELECT ${token(held)}, ${instant(now)}, '${holder}'
               WHERE NOT EXISTS (SELECT 1 FROM recovery_holds WHERE released_at IS NULL AND holder = '${holder}')
              ON CONFLICT DO NOTHING`;
  },
  releaseProducer(held: string, now: number, why: string): string {
    return `UPDATE recovery_holds SET released_at = ${instant(now)}, release_reason = ${reason(why)}, released_by = 'producer'
             WHERE token = ${token(held)} AND released_at IS NULL AND holder = 'producer'`;
  },
  releaseOperator(held: string, now: number, why: OperatorHoldRelease): string {
    if (why !== 'complete' && why !== 'abandoned') throw new Error('an operator recovery hold is released as complete or abandoned');
    return `UPDATE recovery_holds SET released_at = ${instant(now)}, release_reason = '${why}', released_by = 'operator'
             WHERE token = ${token(held)} AND released_at IS NULL AND holder = 'operator'`;
  },
  /**
   * One row answering what a hold token is and what Deployment holds it, so a caller never pairs a hold with an
   * identity it read separately.
   */
  reading(held: string): string {
    return `SELECT (SELECT holder FROM recovery_holds WHERE token = ${token(held)}) AS holder,
                   (SELECT acquired_at FROM recovery_holds WHERE token = ${token(held)}) AS acquired_at,
                   (SELECT released_at FROM recovery_holds WHERE token = ${token(held)}) AS released_at,
                   (SELECT release_reason FROM recovery_holds WHERE token = ${token(held)}) AS release_reason,
                   (SELECT value FROM schema_meta WHERE key = 'deployment_id') AS deployment_id,
                   (SELECT value FROM schema_meta WHERE key = 'version') AS schema_version`;
  },
  open(holder: RecoveryHoldHolder): string {
    return `SELECT token, acquired_at FROM recovery_holds WHERE released_at IS NULL AND holder = '${holder}'`;
  },
};

/** A hold token: what `crypto.randomUUID` mints, and nothing that could carry a quote into a statement. */
const HOLD_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
/** A release reason: the producer's settled attempt, or an operator's completion or abandonment. */
const RELEASE_REASON = /^[A-Za-z0-9 ._-]{1,64}$/;

function token(value: string): string {
  if (!HOLD_TOKEN.test(value)) throw new Error('a recovery hold token is outside its grammar');
  return `'${value}'`;
}
function reason(value: string): string {
  if (!RELEASE_REASON.test(value)) throw new Error('a recovery hold release reason is outside its grammar');
  return `'${value}'`;
}
function instant(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('a recovery hold instant is a whole number of milliseconds');
  return String(value);
}

/** What one `recoveryHoldSql.reading` row says: the hold, and the Deployment that answered for it. */
export interface RecoveryHoldReadingRow {
  holder: string | null;
  acquired_at: number | null;
  released_at: number | null;
  release_reason: string | null;
  deployment_id: string | null;
  schema_version: string | null;
}

/**
 * Opens a hold of `holder` under `token`, answering false when one of that holder is already open: at most one of each
 * holder is open, and the unique index on open holds per holder decides it inside the insert. A token already used
 * answers false too, so retrying the same token is safe and never opens a second hold.
 *
 * An operator hold and a producer hold coexist: a full operator backup does not stop this Deployment admitting its own
 * export, and deletion defers while either is open (`HOLD_OPEN`).
 */
export async function acquireRecoveryHold(db: RelationalStore, token: string, now: number, holder: RecoveryHoldHolder = 'producer'): Promise<boolean> {
  const inserted = await db.prepare(recoveryHoldSql.acquire(token, now, holder)).run();
  return inserted.meta.changes === 1;
}

/**
 * Releases the open producer hold `token` with its reason, answering whether this call released it. A released hold
 * stays released, and an operator hold is never released here: the database refuses it.
 */
export async function releaseRecoveryHold(db: RelationalStore, token: string, now: number, reason: string): Promise<boolean> {
  const released = await db.prepare(recoveryHoldSql.releaseProducer(token, now, reason)).run();
  return released.meta.changes === 1;
}

/**
 * Releases the open operator hold `token`, answering whether this call released it. The one transition an operator hold
 * accepts; a released hold stays released, so a repeated release is safe.
 */
export async function releaseOperatorHold(db: RelationalStore, token: string, now: number, reason: OperatorHoldRelease): Promise<boolean> {
  const released = await db.prepare(recoveryHoldSql.releaseOperator(token, now, reason)).run();
  return released.meta.changes === 1;
}

/** The hold `token` names and the Deployment answering for it, as one row. */
export async function readRecoveryHold(db: RelationalStore, token: string): Promise<{ hold: RecoveryHoldRow | null; sourceIdentity: string }> {
  const row = await db.prepare(recoveryHoldSql.reading(token)).first<RecoveryHoldReadingRow>();
  return recoveryHoldOf(token, row);
}

/** One reading row as a hold and the identity it came with; the identity is what a destination binds its hold to. */
export function recoveryHoldOf(token: string, row: RecoveryHoldReadingRow | null): { hold: RecoveryHoldRow | null; sourceIdentity: string } {
  const sourceIdentity = JSON.stringify({ deploymentId: row?.deployment_id ?? null, schemaVersion: row?.schema_version ?? null });
  if (row === null || row.holder === null) return { hold: null, sourceIdentity };
  return {
    hold: { token, holder: row.holder as RecoveryHoldHolder, acquiredAt: Number(row.acquired_at), releasedAt: row.released_at, releaseReason: row.release_reason },
    sourceIdentity,
  };
}

/** The open hold of `holder`, or null. */
export async function openRecoveryHold(db: RelationalStore, holder: RecoveryHoldHolder): Promise<{ token: string; acquiredAt: number } | null> {
  const row = await db.prepare(recoveryHoldSql.open(holder)).first<{ token: string; acquired_at: number }>();
  return row === null ? null : { token: row.token, acquiredAt: Number(row.acquired_at) };
}

export interface DrainReport {
  /** Expired upload authorities consumed, their bytes journaled. */
  expired: number;
  /** Journal rows the store acknowledged deleting, and removed. */
  deleted: number;
  /** Recorded release candidates decided and removed. */
  decided: number;
  /** A store delete that failed or passed its deadline; its row stays for the next pass. */
  unacknowledged: number;
}

/**
 * One bounded pass of the only store deleter:
 * 1. consume a page of expired upload authorities, journaling their bytes;
 * 2. delete a page of journaled objects, removing each journal row only after the store acknowledged its delete;
 * 3. with no hold open, decide a page of recorded release candidates through the same statements a release runs,
 *    asking the retention owner which backups the policy in force lets go of.
 *
 * Its safety does not rest on running alone: a delete issued twice, late, or by a replaced instance names a key no
 * write will produce again, and a journal row is removed by its primary key.
 */
export async function drainObjectReleases(
  env: Pick<ServerEnv, 'db' | 'blobs'>, now: number, clock: () => number = Date.now,
): Promise<DrainReport> {
  const { db } = env;
  const report: DrainReport = { expired: 0, deleted: 0, decided: 0, unacknowledged: 0 };

  const expired = `expires_at <= ? ORDER BY expires_at, reservation_id LIMIT ${DRAIN_PAGE}`;
  const [, consumed] = await db.batch(consumeExpiredAuthorities(db, expired, [now], now));
  report.expired = consumed!.meta.changes;

  const { results: journal } = await db
    .prepare(`SELECT physical FROM object_releases ORDER BY created_at, physical LIMIT ?`).bind(DRAIN_PAGE)
    .all<{ physical: string }>();
  for (const { physical } of journal) {
    try {
      await within(() => env.blobs.delete(physical), DRAIN_DELETE_MS, clock);
    } catch (error) {
      report.unacknowledged += 1;
      emit({ kind: 'object_release_unacknowledged', error_class: classify(error) });
      break;
    }
    await db.prepare(`DELETE FROM object_releases WHERE physical = ?`).bind(physical).run();
    report.deleted += 1;
  }

  if (await db.prepare(`SELECT ${HOLD_OPEN} AS held`).first<{ held: number }>().then((row) => row?.held === 1)) return report;
  const { results: blobCandidates } = await db
    .prepare(`SELECT project_id, key FROM blob_release_candidates ORDER BY created_at, project_id, key LIMIT ?`).bind(DRAIN_PAGE)
    .all<{ project_id: string; key: string }>();
  if (blobCandidates.length > 0) {
    const page = blobPageOf(blobCandidates.map((row) => ({ projectId: row.project_id, key: row.key })));
    const results = await db.batch(blobDecisionStatements(db, page, now));
    report.decided += results[2]!.meta.changes;
  }
  const { results: backupCandidates } = await db
    .prepare(`SELECT id FROM backup_release_candidates ORDER BY created_at, id LIMIT ?`).bind(DRAIN_PAGE)
    .all<{ id: string }>();
  if (backupCandidates.length > 0) {
    const victims = await currentRetentionVictims(db, await backupRetentionPolicy(db));
    const results = await db.batch(backupDecisionStatements(db, JSON.stringify(backupCandidates.map((row) => row.id)), victims, now));
    report.decided += results[2]!.meta.changes;
  }
  return report;
}

/**
 * Clears what a restored database carries of its source's object lifecycle, on the prepared copy before it is
 * published: the source's holds, journal and upload authorities belong to the source's store, and a restored open hold
 * would defer every release at the destination. Blob release candidates are kept: each is judged again against the
 * rows before anything is released. Backup candidates are dropped: backup retention decides again at the destination.
 */
export async function resetRecoveryLedger(db: RelationalStore): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM recovery_holds`),
    db.prepare(`DELETE FROM object_releases`),
    db.prepare(`DELETE FROM blob_reservations`),
    db.prepare(`DELETE FROM backup_release_candidates`),
  ]);
}

/**
 * Names every registered blob of a prepared restore copy under one fresh generation, so the restored objects are
 * written under names no earlier write in the destination store used.
 */
export async function assignRestoreGeneration(db: RelationalStore, generation: string): Promise<void> {
  await db.prepare(`UPDATE blobs SET generation = ?`).bind(generation).run();
}
