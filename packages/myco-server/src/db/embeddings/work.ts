import type { RelationalStore } from '../../core/adapters.js';
import { embeddingDueInsert, INPUT_REFUSAL_RETRY_MS } from '../embedding-due.js';
import { currentEmbeddingSourceSql } from '../embedding-retirement.js';
import { DELETION_RETRIES, RECEIPT } from '../../core/embedding/receipt-state.js';
import type { VectorType } from '../../core/embedding/vectors.js';
import { registeredObjectKeySql } from '../../core/blob-objects.js';
import type { EmbeddingSource } from '../../read/embedding.js';
import { binaryOrder } from '../../read/scope.js';
import { eligibleEmbeddingSource } from '../embedding-sources.js';
import { commit, read, readSet, write } from '../index.js';
import { SOURCE_STATE_RECONCILE } from './state.js';

/** Source identities one initialization page of a model reads. */
export const MODEL_INIT_PAGE = 256;
/** The vector types embedding writes, in the order work rotates through them. */
const TYPES = `('session','spore','plan')`;
/** The `model_key` of a failure no model can read past. */
const ANY_MODEL = "''";
const RECEIPT_READY = 1;
const RECEIPT_DELETION_SENT = -1;
const RECEIPT_DELETION_FAILED = -2;

interface ModelRow { scan_type: string; scan_id: string; complete: number; active: number }

const registerModel = write<[string, string]>({ name: 'embedding.registerModel',
  sql: 'INSERT INTO embedding_models(project_id,model_key) VALUES(?1,?2) ON CONFLICT DO NOTHING' });
const modelRow = read<[string, string], ModelRow>({ name: 'embedding.modelRow',
  sql: 'SELECT scan_type,scan_id,complete,active FROM embedding_models WHERE project_id=?1 AND model_key=?2' });
const dropInactiveDue = write<[string, string, number]>({ name: 'embedding.dropInactiveDue',
  sql: `DELETE FROM embedding_due WHERE rowid IN (SELECT rowid FROM embedding_due WHERE project_id=?1 AND model_key=?2 AND
    (SELECT active FROM embedding_models WHERE project_id=?1 AND model_key=?2)=0 LIMIT ?3)` });
const reactivateModel = write<[string, string]>({ name: 'embedding.reactivateModel',
  sql: `UPDATE embedding_models SET active=1,complete=0,scan_type='',scan_id='' WHERE project_id=?1 AND model_key=?2 AND active=0
    AND NOT EXISTS(SELECT 1 FROM embedding_due WHERE project_id=?1 AND model_key=?2)` });
const initKeys = read<[string, string, string, number], { type: string; record_id: string }>({ name: 'embedding.initKeys',
  sql: 'SELECT type,record_id FROM embedding_versions WHERE project_id=?1 AND (type,record_id)>(?2,?3) ORDER BY type,record_id LIMIT ?4' });
const initDue = write<[string, string, string, string, string, string]>({ name: 'embedding.initDue',
  sql: embeddingDueInsert(`k.model_key=?1 AND v.project_id=?2 AND (v.type,v.record_id)>(?3,?4) AND (v.type,v.record_id)<=(?5,?6)
    AND EXISTS(SELECT 1 FROM embedding_models WHERE project_id=?2 AND model_key=?1 AND scan_type=?3 AND scan_id=?4 AND complete=0)`) });
const advanceInit = write<[string, string, number, string, string, string, string]>({ name: 'embedding.advanceInit',
  sql: `UPDATE embedding_models SET scan_type=?1,scan_id=?2,complete=?3 WHERE project_id=?4 AND model_key=?5 AND scan_type=?6 AND scan_id=?7 AND complete=0` });
const retainModels = write<[string, string]>({ name: 'embedding.retainModels',
  sql: 'UPDATE embedding_models SET active=0 WHERE project_id=?1 AND active=1 AND model_key NOT IN (SELECT value FROM json_each(?2))' });

/**
 * Initialize one page of a model's work for a Project: its due identities and its per-source state, with the page's
 * frontier, in one commit. Mutations after the frontier maintain both through triggers, so `complete` is the model's
 * activation: its work and state hold every current source from then on. A reactivated model first drops the due rows
 * it kept while inactive, a page at a time.
 */
export async function prepareEmbeddingDue(db: RelationalStore, projectId: string, model: string): Promise<{ more: boolean; ready: boolean }> {
  let [, rows] = await commit(db, registerModel.bind(projectId, model), modelRow.bind(projectId, model));
  let row = rows.results[0];
  if (row === undefined) throw new Error('embedding_model_absent');
  if (row.active === 0) {
    const [, , again] = await commit(db, dropInactiveDue.bind(projectId, model, MODEL_INIT_PAGE), reactivateModel.bind(projectId, model), modelRow.bind(projectId, model));
    row = again.results[0];
    if (row === undefined) throw new Error('embedding_model_absent');
    if (row.active === 0) return { more: true, ready: false };
  }
  if (row.complete === 1) return { more: false, ready: true };
  const [page] = await readSet(db, initKeys.bind(projectId, row.scan_type, row.scan_id, MODEL_INIT_PAGE));
  const last = page.at(-1);
  const keys = JSON.stringify(page.map(key => [projectId, key.type, key.record_id]));
  await commit(db,
    initDue.bind(model, projectId, row.scan_type, row.scan_id, last?.type ?? '', last?.record_id ?? ''),
    ...SOURCE_STATE_RECONCILE.map(statement => statement.bind(keys)),
    advanceInit.bind(last?.type ?? row.scan_type, last?.record_id ?? row.scan_id, page.length < MODEL_INIT_PAGE ? 1 : 0, projectId, model, row.scan_type, row.scan_id));
  return { more: page.length === MODEL_INIT_PAGE, ready: true };
}

/** Inactive models receive no new due identities or state; reactivation re-initializes them. */
export async function retainEmbeddingModels(db: RelationalStore, projectId: string, models: readonly string[]): Promise<void> {
  await commit(db, retainModels.bind(projectId, JSON.stringify(models)));
}

const dueHead = read<[string, string, number], { pending: number }>({ name: 'embedding.dueHead',
  sql: `SELECT 1 AS pending FROM embedding_due WHERE project_id=?1 AND model_key=?2 AND type IN ${TYPES} AND stale IN (0,1) AND retry_at<=?3 LIMIT 1` });

/**
 * Whether a Project holds a source to embed: one seek of the maintained eligible-source set, never an eligibility
 * walk. Until the source-state projection is installed, any version counts.
 */
export const hasSourcesToEmbed = read<[string], { found: number }>({ name: 'embedding.hasSourcesToEmbed',
  sql: `SELECT CASE WHEN (SELECT done FROM projection_catchup WHERE projection='embedding_state' AND phase='versions')=1
    THEN EXISTS (SELECT 1 FROM embedding_eligible_sources WHERE project_id=?1) ELSE EXISTS (SELECT 1 FROM embedding_versions WHERE project_id=?1) END AS found` });

/**
 * Whether any of `models` has source work due for a Project now: a model not yet active and initialized there while the
 * Project holds a source to embed, whose first step initializes it, or a due identity whose retry time has come. Reads
 * one model row and seeks the due index per model, and the eligible-source set once; it never reads the sources.
 */
export async function dueSourceWork(db: RelationalStore, projectId: string, models: readonly string[], now: number): Promise<boolean> {
  if (models.length === 0) return false;
  const [sources, ...perModel] = await readSet(db, hasSourcesToEmbed.bind(projectId), ...models.flatMap(model => [modelRow.bind(projectId, model), dueHead.bind(projectId, model, now)]));
  for (let i = 0; i < perModel.length; i += 2) {
    const row = perModel[i]![0] as ModelRow | undefined;
    if (row === undefined || row.active === 0 || row.complete === 0) { if (sources[0]?.found === 1) return true; }
    else if (perModel[i + 1]!.length > 0) return true;
  }
  return false;
}

interface WorkRow { revision: number; checked_revision: number; pending: number; wake_at: number | null; scope: string }

export const workRow = read<[string, string, string], WorkRow>({ name: 'embedding.workRow',
  sql: `SELECT revision,checked_revision,pending,wake_at,scope FROM embedding_work_state WHERE project_id=?1 AND model_key=?2 AND kind=?3` });
export const workScope = write<[string, string, string, string]>({ name: 'embedding.workScope',
  sql: `INSERT INTO embedding_work_state(project_id,model_key,kind,scope) VALUES(?1,?2,?3,?4)
    ON CONFLICT(project_id,model_key,kind) DO UPDATE SET scope=excluded.scope,revision=revision+1,
      checked_revision=-1,pending=1,wake_at=NULL,sweep_at=0,sweep_cursor=NULL,idle_rounds=0
    WHERE scope<>excluded.scope` });
/** Acknowledges the revision a check read; a concurrent dirtying write leaves the row unacknowledged. */
export const workChecked = write<[number, number | null, number, string | null, number, string, string, string, string, number], { revision: number }>({ name: 'embedding.workChecked',
  sql: `UPDATE embedding_work_state SET revision=revision+1,checked_revision=revision+1,pending=?1,wake_at=?2,sweep_at=?3,sweep_cursor=?4,idle_rounds=?5
    WHERE project_id=?6 AND model_key=?7 AND kind=?8 AND scope=?9 AND revision=?10 RETURNING revision` });

/** The Deployment's attempt clock: every embedding attempt takes the next value, so attempts are unique and ordered. */
const CLOCK = '(SELECT seq FROM embedding_attempt_clock WHERE slot=1)';
const mintAttempt = write<[], { seq: number }>({ name: 'embedding.mintAttempt', sql: 'UPDATE embedding_attempt_clock SET seq=seq+1 WHERE slot=1 RETURNING seq' });

interface HoldRow { failures: number; retry_at: number | null; attempt: number }
const holdRow = read<[string], HoldRow>({ name: 'embedding.providerHold', sql: 'SELECT failures,retry_at,attempt FROM embedding_provider_holds WHERE model_key=?1' });
const providerRevision = read<[], { value: string }>({ name: 'embedding.providerRevision', sql: "SELECT value FROM schema_meta WHERE key='embedding_provider_revision'" });
/**
 * Count one failure of attempt `?6` under configuration `?5`. The hold always keeps the newest attempt that failed, so
 * a failure arriving out of order or concurrently never lowers the fence a success must pass. The backoff moves only
 * from the failure count it read (`?2`): when another failure landed first, this one raises the fence and leaves that
 * failure's count and deadline. A call started under a superseded configuration records nothing.
 */
const recordFailure = write<[string, number, number, string, string, number]>({ name: 'embedding.providerFailure',
  sql: `INSERT INTO embedding_provider_holds(model_key,failures,retry_at,reason,attempt)
    SELECT ?1,?2+1,?3,?4,?6 WHERE (SELECT value FROM schema_meta WHERE key='embedding_provider_revision')=?5
    ON CONFLICT(model_key) DO UPDATE SET attempt=MAX(embedding_provider_holds.attempt,excluded.attempt),
      failures=CASE WHEN embedding_provider_holds.failures=?2 THEN excluded.failures ELSE embedding_provider_holds.failures END,
      retry_at=CASE WHEN embedding_provider_holds.failures=?2 THEN excluded.retry_at ELSE embedding_provider_holds.retry_at END,
      reason=CASE WHEN embedding_provider_holds.failures=?2 THEN excluded.reason ELSE embedding_provider_holds.reason END` });
/** A success clears only a hold every failing attempt of which started before it, under the configuration it ran with. */
const clearHold = write<[string, number, string]>({ name: 'embedding.providerClear',
  sql: `DELETE FROM embedding_provider_holds WHERE model_key=?1 AND attempt<?2
    AND (SELECT value FROM schema_meta WHERE key='embedding_provider_revision')=?3` });

export async function providerHold(db: RelationalStore, model: string): Promise<HoldRow | null> {
  const [rows] = await readSet(db, holdRow.bind(model));
  return rows[0] ?? null;
}

export async function providerConfiguration(db: RelationalStore): Promise<string> {
  const [rows] = await readSet(db, providerRevision.bind());
  return rows[0]!.value;
}

export async function recordProviderFailure(db: RelationalStore, model: string, prior: number, retryAt: number, reason: string, revision: string, attempt: number): Promise<void> {
  await commit(db, recordFailure.bind(model, prior, retryAt, reason, revision, attempt));
}

export async function clearProviderHold(db: RelationalStore, model: string, attempt: number, revision: string): Promise<void> {
  await commit(db, clearHold.bind(model, attempt, revision));
}

const journalCursor = write<[string, number]>({ name: 'embedding.journalCursor',
  sql: 'INSERT INTO embedding_cursors(project_id,next_type) VALUES(?1,?2) ON CONFLICT(project_id) DO UPDATE SET next_type=excluded.next_type' });
const journalAttempt = write<[number, string, string, string]>({ name: 'embedding.journalAttempt',
  sql: 'UPDATE embedding_versions SET attempted_at=?1 WHERE project_id=?2 AND type=?3 AND record_id=?4' });
const journalReceipt = write<[string, string, string, string, string, string, number]>({ name: 'embedding.journalReceipt',
  sql: `INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,updated_at,attempt) VALUES(?1,?2,?3,?4,?5,?6,?7,${CLOCK})
    ON CONFLICT(project_id,model_key,id) DO UPDATE SET updated_at=excluded.updated_at,attempt=excluded.attempt` });
const attemptAuthority = read<[string, string], { epoch: number; config: string }>({ name: 'embedding.attemptAuthority',
  sql: `SELECT COALESCE((SELECT epoch FROM embedding_models WHERE project_id=?1 AND model_key=?2),0) AS epoch,
    (SELECT value FROM schema_meta WHERE key='embedding_provider_revision') AS config` });
const rejournal = write<[number, string, string, string, number], { id: string }>({ name: 'embedding.rejournal',
  sql: 'UPDATE embedding_receipts SET updated_at=?1 WHERE project_id=?2 AND model_key=?3 AND id=?4 AND ready=0 AND attempt=?5 RETURNING id' });

/** A source write's identity: its receipt and the source revision it read, with the instant its attempt starts. */
export interface SourceTarget { projectId: string; model: string; id: string; type: string; recordId: string; revision: string; at: number }
/** A journaled attempt: its place on the attempt clock, and the model epoch and provider configuration it runs under. */
export interface SourceAttempt extends SourceTarget { seq: number; epoch: number; config: string }

/**
 * Journal an attempt before any external write, in one commit: it takes the next attempt from the clock, records the
 * type rotation, the source's attempt time and its receipt under that attempt, and reads the epoch and configuration
 * every later settlement of the attempt must still match.
 */
export async function journalSourceAttempt(db: RelationalStore, t: SourceTarget, nextType: number): Promise<SourceAttempt> {
  const [minted, , , , authority] = await commit(db, mintAttempt.bind(), journalCursor.bind(t.projectId, nextType),
    journalAttempt.bind(t.at, t.projectId, t.type, t.recordId), journalReceipt.bind(t.projectId, t.model, t.id, t.type, t.recordId, t.revision, t.at),
    attemptAuthority.bind(t.projectId, t.model));
  return { ...t, seq: minted.results[0]!.seq, epoch: authority.results[0]!.epoch, config: authority.results[0]!.config };
}

/** Re-journal just before the upsert; answers false when a newer attempt or a deletion claim holds the receipt now. */
export async function rejournalSourceAttempt(db: RelationalStore, a: SourceAttempt): Promise<boolean> {
  const [claimed] = await commit(db, rejournal.bind(a.at, a.projectId, a.model, a.id, a.seq));
  return claimed.results.length === 1;
}

const sameEpoch = (project: string, model: string, epoch: string) => `EXISTS(SELECT 1 FROM embedding_models WHERE project_id=${project} AND model_key=${model} AND epoch=${epoch})`;

const passOver = write<[string, string, string, string, string, string, number, number, string, number]>({ name: 'embedding.passOver',
  sql: `INSERT INTO embedding_source_failures(project_id,type,record_id,model_key,revision,reason,recorded_at,attempt)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM embedding_versions WHERE project_id=?1 AND type=?2 AND record_id=?3 AND revision=?5)
      AND ${sameEpoch('?1', '?9', '?10')}
    ON CONFLICT(project_id,type,record_id,model_key) DO UPDATE SET revision=excluded.revision,reason=excluded.reason,recorded_at=excluded.recorded_at,attempt=excluded.attempt
    WHERE embedding_source_failures.attempt<excluded.attempt` });

/**
 * Record that `a`'s source is passed over under `model` (or `ANY_MODEL`), saying why: only while the revision it read is
 * still current and the model's epoch is unchanged, and never replacing a failure a later attempt recorded.
 */
export async function passOverSource(db: RelationalStore, a: SourceAttempt, model: string, reason: string): Promise<void> {
  await commit(db, passOver.bind(a.projectId, a.type, a.recordId, model, a.revision, reason, a.at, a.seq, a.model, a.epoch));
}

const settleFailures = write<[string, string, string, string, number, number]>({ name: 'embedding.settleFailures',
  sql: `DELETE FROM embedding_source_failures WHERE project_id=?1 AND type=?2 AND record_id=?3 AND model_key IN (${ANY_MODEL},?4) AND attempt<?5
    AND ${sameEpoch('?1', '?4', '?6')}` });
const settleReady = write<[string, string, string, string, string, string, number, number]>({ name: 'embedding.settleReady',
  sql: `UPDATE embedding_receipts SET ready=${RECEIPT_READY} WHERE project_id=?1 AND model_key=?2 AND id=?3 AND ready=0 AND attempt=?7
    AND ${sameEpoch('?1', '?2', '?8')}
    AND EXISTS(SELECT 1 FROM embedding_versions v WHERE v.project_id=?1 AND v.type=?4 AND v.record_id=?5 AND v.revision=?6 AND ${eligibleEmbeddingSource('v')})` });
const settleLateClaim = write<[string, string, string, string, string, string, number, number]>({ name: 'embedding.settleLateClaim',
  sql: `INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at,attempt) VALUES(?1,?2,?3,?4,?5,?6,${RECEIPT_DELETION_SENT},?7,${CLOCK})
    ON CONFLICT(project_id,model_key,id) DO UPDATE SET ready=${RECEIPT_DELETION_SENT},updated_at=excluded.updated_at,attempt=excluded.attempt
    WHERE NOT ${sameEpoch('?1', '?2', '?8')}` });

/**
 * Settle a landed vector write in one commit, fenced by its attempt. It clears only failures earlier attempts recorded,
 * so a late success never erases a failure a newer attempt or a newer revision recorded, however close their clocks.
 * It marks the receipt indexed only while the receipt still carries this attempt, the model epoch is unchanged and the
 * revision is current. A write that lands after its receipt is retired, or after a reset advanced the epoch, leaves a
 * deletion claim stamped at the current clock, which a reset's retirement keeps, so its vector is deleted in turn.
 */
export async function settleSourceWrite(db: RelationalStore, a: SourceAttempt): Promise<void> {
  await commit(db,
    settleFailures.bind(a.projectId, a.type, a.recordId, a.model, a.seq, a.epoch),
    settleReady.bind(a.projectId, a.model, a.id, a.type, a.recordId, a.revision, a.seq, a.epoch),
    settleLateClaim.bind(a.projectId, a.model, a.id, a.type, a.recordId, a.revision, a.at, a.epoch));
}

const claimDeletion = write<[number, string, string, string, number, number], { attempt: number }>({ name: 'embedding.claimDeletion',
  sql: `UPDATE embedding_receipts SET ready=${RECEIPT_DELETION_SENT},updated_at=?1,attempt=${CLOCK}
    WHERE project_id=?2 AND model_key=?3 AND id=?4 AND ready=?5 AND updated_at=?6 RETURNING attempt` });
const deletionFailed = write<[string, string, string, number]>({ name: 'embedding.deletionFailed',
  sql: `UPDATE embedding_receipts SET ready=${RECEIPT_DELETION_FAILED} WHERE project_id=?1 AND model_key=?2 AND id=?3 AND ready=${RECEIPT_DELETION_SENT} AND attempt=?4` });
const deletionConfirmed = write<[string, string, string, number]>({ name: 'embedding.deletionConfirmed',
  sql: `DELETE FROM embedding_receipts WHERE project_id=?1 AND model_key=?2 AND id=?3 AND ready=${RECEIPT_DELETION_SENT} AND attempt=?4` });

/** A deletion attempt: the receipt it claims, the state and time it read, and the instant the attempt starts. */
export interface DeletionAttempt { projectId: string; model: string; id: string; ready: number; updatedAt: number; at: number }

/** Claim a receipt for deletion before the delete is sent, under a fresh attempt; null when another attempt moved it first. */
export async function claimReceiptDeletion(db: RelationalStore, d: DeletionAttempt): Promise<number | null> {
  const [, claimed] = await commit(db, mintAttempt.bind(), claimDeletion.bind(d.at, d.projectId, d.model, d.id, d.ready, d.updatedAt));
  return claimed.results[0]?.attempt ?? null;
}

/** Settle claim `attempt`: retire the receipt once the store no longer returns the vector, else mark it for retry. */
export async function settleReceiptDeletion(db: RelationalStore, d: DeletionAttempt, attempt: number, outcome: 'confirmed' | 'failed'): Promise<void> {
  await commit(db, (outcome === 'confirmed' ? deletionConfirmed : deletionFailed).bind(d.projectId, d.model, d.id, attempt));
}

const resetMint = write<[]>({ name: 'embedding.resetMint', sql: 'UPDATE embedding_attempt_clock SET seq=seq+1 WHERE slot=1' });
const resetForget = write<[]>({ name: 'embedding.resetForget',
  sql: "DELETE FROM embedding_resets WHERE NOT EXISTS (SELECT 1 FROM projection_catchup WHERE projection='embedding_reset' AND done=0)" });
const resetAdmit = write<[string]>({ name: 'embedding.resetAdmit',
  sql: `INSERT INTO embedding_resets(project_id,seq) VALUES(?1,${CLOCK}) ON CONFLICT(project_id) DO UPDATE SET seq=excluded.seq` });
const resetEpoch = write<[string]>({ name: 'embedding.resetEpoch', sql: 'UPDATE embedding_models SET epoch=epoch+1 WHERE project_id=?1' });
const resetCursor = write<[string]>({ name: 'embedding.resetCursor', sql: 'DELETE FROM embedding_cursors WHERE project_id=?1' });
const resetRestart = write<[]>({ name: 'embedding.resetRestart',
  sql: "UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL,generation=generation+CASE WHEN done=0 AND after_key='[]' AND frontier IS NULL THEN 0 ELSE 1 END WHERE projection='embedding_reset'" });

/**
 * Admit a rebuild of a Project whose vector namespace is empty, in one bounded commit: every model's epoch there
 * advances, so attempts begun before it settle nothing, readiness reads `building`, and the shared catch-up job then
 * retires the receipts, failures and calibration members recorded before the reset, a bounded page at a time. Source
 * revisions remain intact, and their sources become due as their receipts retire.
 */
export async function resetEmbeddingIndex(db: RelationalStore, projectId: string): Promise<void> {
  await commit(db, resetMint.bind(), resetForget.bind(), resetAdmit.bind(projectId), resetEpoch.bind(projectId), resetCursor.bind(projectId), resetRestart.bind());
}

/** The reset pages the shared catch-up runs: each removes only rows its Project's reset outdates, so replay is safe. */
const RESET = (row: string) => `(SELECT seq FROM embedding_resets r WHERE r.project_id=${row}.project_id)`;
export const RESET_RECONCILE = {
  resetReceipts: [write<[string]>({ name: 'embedding.resetReceiptsPage', sql: `DELETE FROM embedding_receipts WHERE (project_id,model_key,id) IN
    (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?1)) AND attempt<${RESET('embedding_receipts')}` })],
  resetFailures: [write<[string]>({ name: 'embedding.resetFailuresPage', sql: `DELETE FROM embedding_source_failures WHERE (project_id,type,record_id,model_key) IN
    (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]') FROM json_each(?1))
    AND attempt<${RESET('embedding_source_failures')}` })],
  resetMembers: [write<[string]>({ name: 'embedding.resetMembersPage', sql: `DELETE FROM embedding_hubness_members WHERE (project_id,model_key,id) IN
    (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?1))
    AND NOT EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id=embedding_hubness_members.project_id AND r.model_key=embedding_hubness_members.model_key
      AND r.id=embedding_hubness_members.id AND r.attempt>=${RESET('embedding_hubness_members')})` })],
};
const RESETTING = 'project_id IN (SELECT project_id FROM embedding_resets)';
export const RESET_PHASE_SOURCES = {
  resetFailures: { table: 'embedding_source_failures', columns: ['project_id', 'type', 'record_id', 'model_key'], where: RESETTING },
  resetMembers: { table: 'embedding_hubness_members', columns: ['project_id', 'model_key', 'id'], where: RESETTING },
  resetReceipts: { table: 'embedding_receipts', columns: ['project_id', 'model_key', 'id'], where: RESETTING },
} as const;

const typeCursor = read<[string], { next_type: number }>({ name: 'embedding.typeCursor', sql: 'SELECT next_type FROM embedding_cursors WHERE project_id=?1' });
const nextDue = read<[string, string, string, number, number], { record_id: string; revision: string }>({ name: 'embedding.nextDue',
  sql: `SELECT record_id,revision FROM embedding_due WHERE project_id=?1 AND model_key=?2 AND type=?3 AND stale=?4 AND retry_at<=?5
    ORDER BY retry_at,attempted_at,record_id LIMIT 1` });

/** The vector type a Project's next write starts its rotation at. */
export async function nextWriteType(db: RelationalStore, projectId: string): Promise<number> {
  const [rows] = await readSet(db, typeCursor.bind(projectId));
  return rows[0]?.next_type ?? 0;
}

/** The next due source of one type under a model: never-written first, then sources whose vector is stale. */
export async function nextDueSource(db: RelationalStore, projectId: string, model: string, type: string, now: number): Promise<{ record_id: string; revision: string; stale: boolean } | null> {
  const [fresh, stale] = await readSet(db, nextDue.bind(projectId, model, type, 0, now), nextDue.bind(projectId, model, type, 1, now));
  const row = fresh[0] ?? stale[0];
  return row === undefined ? null : { ...row, stale: fresh[0] === undefined };
}

/** The work rows a scheduling check covered for one Project, as `[model_key, kind]` pairs: what a cleared attention row must find clean. */
export type CheckedWork = ReadonlyArray<readonly [string, 'embedding' | 'hubness']>;
/** Projects one audit page reads, and the most attention rows one scheduling check reads. */
export const WORK_AUDIT_PAGE = 50;
export const WORK_ATTENTION_PAGE = 32;

/**
 * The scheduling schema: a Project-keyed attention set every work-dirtying trigger adds its Project to (one key seek,
 * no write when it is already there), the Deployment's audit frontier, a partial index over work rows waiting on a
 * deadline, and an index that seeks a Project's current passed-over membership by model and expiry.
 */
export function workScheduleSchema(projectIdCheck: string): string[] {
  return [
    'CREATE INDEX IF NOT EXISTS idx_embedding_passed_over_current ON embedding_passed_over(project_id,model_key,expires_at)',
    `CREATE TABLE IF NOT EXISTS embedding_work_attention(project_id TEXT PRIMARY KEY CHECK (${projectIdCheck})) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS embedding_work_audit(slot INTEGER PRIMARY KEY CHECK (slot=1),scope TEXT NOT NULL,after TEXT NOT NULL,
      done INTEGER NOT NULL CHECK (done IN (0,1)),audited_at INTEGER NOT NULL,cursor TEXT NOT NULL DEFAULT '')`,
    'CREATE INDEX IF NOT EXISTS idx_embedding_work_wake ON embedding_work_state(model_key,wake_at) WHERE wake_at IS NOT NULL',
  ];
}

/**
 * The work-dirtying triggers: a source version, receipt, failure, plan proof, calibration member or calibration cursor
 * mutation dirties its Project's work rows and adds the Project to the attention set in the same statement; a change to
 * a model's activation, initialization or epoch does the same for that Project's rows.
 */
export function workDirtyTriggers(sessionEligibility: string): Array<{ name: string; table: string; sql: string }> {
  const dirty = (table: string, kinds = "'embedding','hubness'", update = 'UPDATE', when?: (operation: string) => string) =>
    ['INSERT', update, 'DELETE'].map((operation) => {
      const rows = operation.startsWith('UPDATE') ? ['OLD', 'NEW'] : [operation === 'DELETE' ? 'OLD' : 'NEW'];
      const name = `${table}_work_${operation.split(' ')[0]!.toLowerCase()}`;
      return { name, table, sql: `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${operation} ON ${table} ${when === undefined ? '' : `WHEN ${when(operation)}`} BEGIN
      UPDATE embedding_work_state SET revision=revision+1,pending=1,wake_at=NULL,sweep_cursor=NULL,idle_rounds=0
        WHERE project_id IN (${rows.map((row) => `${row}.project_id`).join(',')}) AND kind IN (${kinds});
      INSERT INTO embedding_work_attention(project_id) VALUES${rows.map((row) => `(${row}.project_id)`).join(',')} ON CONFLICT DO NOTHING; END` };
    });
  return [
    ...dirty('embedding_versions', undefined, 'UPDATE OF project_id,type,record_id,revision', (operation) => {
      const rows = operation === 'INSERT' ? ['NEW'] : operation === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
      return rows.map((row) => `(${row}.type <> 'session' OR EXISTS (SELECT 1 FROM sessions
      WHERE project_id=${row}.project_id AND session_id=${row}.record_id AND ${sessionEligibility})
      OR EXISTS (SELECT 1 FROM embedding_receipts WHERE project_id=${row}.project_id AND type='session' AND record_id=${row}.record_id))`).join(' OR ');
    }),
    ...dirty('embedding_receipts', undefined, 'UPDATE OF project_id,model_key,id,type,record_id,revision,ready,updated_at,rewrites'),
    ...dirty('embedding_source_failures'),
    ...dirty('processed_resources', undefined, undefined, (operation) => operation === 'INSERT' ? "NEW.kind = 'plan'" : operation === 'DELETE' ? "OLD.kind = 'plan'" : "OLD.kind = 'plan' OR NEW.kind = 'plan'"),
    ...dirty('embedding_hubness_members', "'hubness'", 'UPDATE OF project_id,model_key,id,state'),
    ...dirty('embedding_cursors', "'hubness'", 'UPDATE OF hubness_model,hubness_count,hubness_cursor'),
  ];
}

/** A model registered for a Project, or one whose activation, initialization or epoch moves, re-arms the Project's work. */
export function workModelTriggers(): Array<{ name: string; table: string; sql: string }> {
  const body = (row: string) => `UPDATE embedding_work_state SET revision=revision+1,pending=1,wake_at=NULL WHERE project_id=${row}.project_id;
      INSERT INTO embedding_work_attention(project_id) VALUES(${row}.project_id) ON CONFLICT DO NOTHING;`;
  return [
    { name: 'embedding_models_work_insert', table: 'embedding_models', sql: `CREATE TRIGGER IF NOT EXISTS embedding_models_work_insert AFTER INSERT ON embedding_models BEGIN
      ${body('NEW')} END` },
    { name: 'embedding_models_work_update', table: 'embedding_models', sql: `CREATE TRIGGER IF NOT EXISTS embedding_models_work_update AFTER UPDATE OF active,complete,epoch ON embedding_models
      WHEN OLD.active IS NOT NEW.active OR OLD.complete IS NOT NEW.complete OR OLD.epoch IS NOT NEW.epoch BEGIN
      ${body('NEW')} END` },
  ];
}

interface AuditRow { scope: string; after: string; done: number; audited_at: number; cursor: string }
interface CandidateRow { project_id: string; archived: number; gone: number; marked: number }
const auditRow = read<[], AuditRow>({ name: 'embedding.workAudit', sql: 'SELECT scope,after,done,audited_at,cursor FROM embedding_work_audit WHERE slot=1' });
const auditRestart = write<[string, number]>({ name: 'embedding.workAuditRestart',
  sql: `INSERT INTO embedding_work_audit(slot,scope,after,done,audited_at) VALUES(1,?1,'',0,?2)
    ON CONFLICT(slot) DO UPDATE SET scope=excluded.scope,after='',done=0,audited_at=excluded.audited_at` });
const auditAdvance = write<[string, number, number, string, string]>({ name: 'embedding.workAuditAdvance',
  sql: 'UPDATE embedding_work_audit SET after=?1,done=?2,audited_at=CASE WHEN ?2=1 THEN ?3 ELSE audited_at END WHERE slot=1 AND scope=?4 AND after=?5 AND done=0' });
const auditCursor = write<[string]>({ name: 'embedding.workAttentionCursor', sql: 'UPDATE embedding_work_audit SET cursor=?1 WHERE slot=1' });
const auditPage = read<[string, number], CandidateRow>({ name: 'embedding.workAuditPage',
  sql: `SELECT p.project_id,p.archived_at IS NOT NULL AS archived,0 AS gone,EXISTS(SELECT 1 FROM embedding_work_attention a WHERE a.project_id=p.project_id) AS marked
    FROM projects p WHERE p.project_id>?1 ORDER BY p.project_id LIMIT ?2` });
const attentionPage = read<[string, number], CandidateRow>({ name: 'embedding.workAttention',
  sql: `SELECT a.project_id,COALESCE(p.archived_at IS NOT NULL,0) AS archived,p.project_id IS NULL AS gone,1 AS marked FROM embedding_work_attention a
    LEFT JOIN projects p ON p.project_id=a.project_id WHERE a.project_id>?1 ORDER BY a.project_id LIMIT ?2` });
const wakingPage = read<[string, number, number], CandidateRow>({ name: 'embedding.workWaking',
  sql: `SELECT DISTINCT w.project_id,COALESCE(p.archived_at IS NOT NULL,0) AS archived,p.project_id IS NULL AS gone,
      EXISTS(SELECT 1 FROM embedding_work_attention a WHERE a.project_id=w.project_id) AS marked
    FROM embedding_work_state w INDEXED BY idx_embedding_work_wake LEFT JOIN projects p ON p.project_id=w.project_id
    WHERE w.model_key IN (SELECT value FROM json_each(?1)) AND w.wake_at IS NOT NULL AND w.wake_at<=?2 LIMIT ?3` });
/** Clears a Project's attention only while every row its check covered is still clean. */
const clearAttention = write<[string, string]>({ name: 'embedding.workAttentionClear',
  sql: `DELETE FROM embedding_work_attention WHERE project_id=?1 AND (NOT EXISTS (SELECT 1 FROM projects WHERE project_id=?1) OR NOT EXISTS (
    SELECT 1 FROM json_each(?2) c JOIN embedding_work_state w ON w.project_id=?1 AND w.model_key=json_extract(c.value,'$[0]') AND w.kind=json_extract(c.value,'$[1]')
    WHERE w.revision<>w.checked_revision OR w.pending=1))` });

/** Where the Deployment's scheduling stands: the audit frontier, and the Projects a check reads now. */
export interface WorkCandidates {
  /** Projects to check, each once: attention first, then those whose wake time came, then the audit page. */
  projects: Array<{ projectId: string; retireOnly: boolean; gone: boolean; marked: boolean; audited: boolean }>;
  /** The audit page's last Project when an audit is under way, to advance after the page is checked; else null. */
  audit: { scope: string; after: string; last: string; done: boolean } | null;
  /** The last attention Project read, which the next dispatch starts after. */
  cursor: string;
  /** Whether the attention page is full: more Projects may wait beyond it. */
  full: boolean;
}

/**
 * The Projects a scheduling check reads: those in the attention set, read in a rotating page after `cursor`; those
 * whose work row's wake time has come; and, while an audit runs, one page of every Project, each probed fresh. An audit
 * starts when the Deployment's work scope `scope` differs from the one last audited, or `intervalMs` after the last
 * audit finished: it is the finite pass that finds what no trigger marks (a Project unarchived, a scope change, a work
 * row resting on a stale answer). Reads a fixed number of rows outside the pages.
 */
export async function workCandidates(db: RelationalStore, scope: string, models: readonly string[], now: number, intervalMs: number, rotate: boolean): Promise<WorkCandidates> {
  let [[audit]] = await readSet(db, auditRow.bind());
  if (audit === undefined || audit.scope !== scope || (audit.done === 1 && audit.audited_at + intervalMs <= now)) {
    const [, again] = await commit(db, auditRestart.bind(scope, now), auditRow.bind());
    audit = again.results[0]!;
  }
  const start = rotate ? audit.cursor : '';
  const auditing = audit.done === 0 && audit.scope === scope;
  const [held, wrapped, waking, page] = await readSet(db, attentionPage.bind(start, WORK_ATTENTION_PAGE),
    attentionPage.bind('', start === '' ? 0 : WORK_ATTENTION_PAGE), wakingPage.bind(JSON.stringify([...new Set(models)]), now, WORK_ATTENTION_PAGE),
    auditPage.bind(auditing ? audit.after : '', auditing ? WORK_AUDIT_PAGE : 0));
  const seen = new Map<string, { projectId: string; retireOnly: boolean; gone: boolean; marked: boolean; audited: boolean }>();
  const attention = [...held, ...(held.length < WORK_ATTENTION_PAGE ? wrapped : [])].slice(0, WORK_ATTENTION_PAGE);
  for (const row of [...attention, ...waking, ...page]) {
    if (!seen.has(row.project_id)) seen.set(row.project_id, { projectId: row.project_id, retireOnly: row.archived === 1, gone: row.gone === 1, marked: row.marked === 1, audited: false });
  }
  for (const row of page) seen.get(row.project_id)!.audited = true;
  return {
    projects: [...seen.values()],
    audit: auditing ? { scope, after: audit.after, last: page.at(-1)?.project_id ?? audit.after, done: page.length < WORK_AUDIT_PAGE } : null,
    cursor: attention.at(-1)?.project_id ?? '',
    full: attention.length === WORK_ATTENTION_PAGE,
  };
}

/** Record that a check covered the audit page, so the next check reads the page after it. */
export async function advanceWorkAudit(db: RelationalStore, audit: NonNullable<WorkCandidates['audit']>, now: number): Promise<void> {
  await commit(db, auditAdvance.bind(audit.last, audit.done ? 1 : 0, now, audit.scope, audit.after));
}

/** The attention Project the next dispatch reads after, so every Project with work is reached in turn. */
export async function rotateWorkAttention(db: RelationalStore, cursor: string): Promise<void> {
  await commit(db, auditCursor.bind(cursor));
}

const markAttention = write<[string]>({ name: 'embedding.workAttentionMark', sql: 'INSERT INTO embedding_work_attention(project_id) VALUES(?1) ON CONFLICT DO NOTHING' });

/** A check found work for a Project an audit or a wake time reached: it joins the attention set until a check finds it idle. */
export async function markWorkAttention(db: RelationalStore, projectId: string): Promise<void> {
  await commit(db, markAttention.bind(projectId));
}

/** A check found no work for a Project: it leaves the attention set unless a mutation dirtied one of its checked rows after the check. */
export async function clearWorkAttention(db: RelationalStore, projectId: string, checked: CheckedWork): Promise<void> {
  await commit(db, clearAttention.bind(projectId, JSON.stringify(checked)));
}

/** Whether scheduling still owes an audit: none yet run for `scope`, or one under way. One fixed row. */
export async function workOwed(db: RelationalStore, scope: string): Promise<boolean> {
  const [[audit]] = await readSet(db, auditRow.bind());
  return audit === undefined || audit.scope !== scope || audit.done === 0;
}

const providerRetry = read<[string, number], { retry_at: number }>({ name: 'embedding.providerRetryAt',
  sql: 'SELECT retry_at FROM embedding_provider_holds WHERE model_key IN (SELECT value FROM json_each(?1)) AND retry_at>?2 ORDER BY retry_at LIMIT 1' });
const providerHolds = read<[string], { model_key: string; retry_at: number | null }>({ name: 'embedding.providerHolds',
  sql: 'SELECT model_key,retry_at FROM embedding_provider_holds WHERE model_key IN (SELECT value FROM json_each(?1))' });

/** The earliest instant a held provider of `models` is asked again, or null. */
export async function providerRetryAt(db: RelationalStore, models: readonly string[], now: number): Promise<number | null> {
  const [[row]] = await readSet(db, providerRetry.bind(JSON.stringify(models), now));
  return row?.retry_at ?? null;
}

/** The models of `models` whose provider may be asked now: no hold, or a hold whose retry time has come. One read. */
export async function readyProviders(db: RelationalStore, models: readonly string[], now: number): Promise<string[]> {
  const [rows] = await readSet(db, providerHolds.bind(JSON.stringify([...new Set(models)])));
  const held = new Map(rows.map(row => [row.model_key, row.retry_at]));
  return models.filter(model => { const at = held.get(model); return at === undefined || (at !== null && at <= now); });
}

/** A receipt due for retirement or a deletion retry. */
export interface RetiringReceipt { id: string; model_key: string; type: VectorType; record_id: string; revision: string; ready: number; updated_at: number }
const RECEIPT_COLUMNS = 'r.id,r.model_key,r.type,r.record_id,r.revision,r.ready,r.updated_at';
const queuedRetirement = read<[string, string], RetiringReceipt>({ name: 'embedding.retirementQueued',
  sql: `SELECT ${RECEIPT_COLUMNS} FROM embedding_retirement_queue q CROSS JOIN embedding_receipts r ON r.project_id=q.project_id AND r.model_key=q.model_key AND r.id=q.id
    WHERE q.project_id=?1 AND q.model_key=?2 AND r.ready>=0 AND NOT ${currentEmbeddingSourceSql('r')} ORDER BY q.updated_at,q.id LIMIT 1` });
/** A receipt under a model outside the retained set: `?2`/`?3` bound the gap between two retained models ('' for none). */
const unretained = (lower: boolean, upper: boolean) => read<[string, ...string[]], RetiringReceipt>({ name: `embedding.retirementUnretained${lower ? 'L' : ''}${upper ? 'U' : ''}`,
  sql: `SELECT ${RECEIPT_COLUMNS} FROM embedding_receipts r WHERE r.project_id=?1 AND r.ready>=${RECEIPT.journaled}${lower ? ' AND r.model_key>?2' : ''}${upper ? ` AND r.model_key<?${lower ? 3 : 2}` : ''}
    ORDER BY r.model_key,r.updated_at,r.id LIMIT 1` });
const UNRETAINED = { '': unretained(false, false), L: unretained(true, false), U: unretained(false, true), LU: unretained(true, true) };
const deletionDue = read<[string, number, number], RetiringReceipt>({ name: 'embedding.retirementDeletionDue',
  sql: `SELECT ${RECEIPT_COLUMNS} FROM embedding_receipts r WHERE r.project_id=?1 AND r.ready<${RECEIPT.journaled} AND r.ready=?2 AND r.updated_at<=?3 ORDER BY r.updated_at,r.id LIMIT 1` });

/**
 * The receipt a Project retires next, oldest first: a queued stale receipt under a retained model, any receipt under a
 * model no longer retained, or a deletion claim whose confirmation or retry wait has passed. One batch of indexed seeks.
 */
export async function retiringReceipt(db: RelationalStore, projectId: string, retained: readonly string[], now: number): Promise<RetiringReceipt | null> {
  const models = [...new Set(retained)].sort(binaryOrder);
  const gaps = Array.from({ length: models.length + 1 }, (_, index) => {
    const lower = models[index - 1], upper = models[index];
    const key = `${lower === undefined ? '' : 'L'}${upper === undefined ? '' : 'U'}` as keyof typeof UNRETAINED;
    return UNRETAINED[key].bind(projectId, ...(lower === undefined ? [] : [lower]), ...(upper === undefined ? [] : [upper]));
  });
  const found = await readSet(db, ...models.map(model => queuedRetirement.bind(projectId, model)), ...gaps,
    ...DELETION_RETRIES.map(({ state, waitMs }) => deletionDue.bind(projectId, state, now - waitMs)));
  return found.flat().sort((a, b) => a.updated_at - b.updated_at || binaryOrder(a.id, b.id))[0] ?? null;
}

const failureWake = read<[string, string, number], { at: number }>({ name: 'embedding.failureWakeAt',
  sql: 'SELECT recorded_at AS at FROM embedding_source_failures WHERE project_id=?1 AND model_key=?2 AND recorded_at>?3 ORDER BY recorded_at LIMIT 1' });
const deletionWake = read<[string, number, number], { at: number }>({ name: 'embedding.deletionWakeAt',
  sql: `SELECT updated_at AS at FROM embedding_receipts WHERE project_id=?1 AND ready<${RECEIPT.journaled} AND ready=?2 AND updated_at>?3 ORDER BY updated_at LIMIT 1` });

/** The earliest source refusal expiry under a model, read through its retry index. */
export async function embeddingFailureWakeAt(db: RelationalStore, projectId: string, model: string, now: number): Promise<number | null> {
  const [[row]] = await readSet(db, failureWake.bind(projectId, model, now - INPUT_REFUSAL_RETRY_MS));
  return row === undefined ? null : row.at + INPUT_REFUSAL_RETRY_MS;
}

/** The earliest timed retry of a Project's work: a refusal expiring under one of `writes`, or a deletion wait ending. */
export async function embeddingWakeAt(db: RelationalStore, projectId: string, writes: readonly string[], now: number): Promise<number | null> {
  const rows = await readSet(db, ...writes.map(model => failureWake.bind(projectId, model, now - INPUT_REFUSAL_RETRY_MS)),
    ...DELETION_RETRIES.map(({ state, waitMs }) => deletionWake.bind(projectId, state, now - waitMs)));
  const deadlines = [
    ...rows.slice(0, writes.length).flatMap(found => found.map(row => row.at + INPUT_REFUSAL_RETRY_MS)),
    ...rows.slice(writes.length).flatMap((found, i) => found.map(row => row.at + DELETION_RETRIES[i]!.waitMs)),
  ];
  return deadlines.length === 0 ? null : Math.min(...deadlines);
}

const sourceRow = read<[string, string, string, string], EmbeddingSource & { object_key: string | null }>({ name: 'embedding.source',
  sql: `SELECT s.*,${registeredObjectKeySql('s.project_id', 's.blob_key')} AS object_key FROM embedding_sources s WHERE s.project_id=?1 AND s.type=?2 AND s.record_id=?3 AND s.revision=?4` });

/** One current source's text and metadata at the revision a due row names, or null once that revision is gone. */
export async function embeddingSource(db: RelationalStore, projectId: string, type: string, recordId: string, revision: string): Promise<(EmbeddingSource & { object_key: string | null }) | null> {
  const [[row]] = await readSet(db, sourceRow.bind(projectId, type, recordId, revision));
  return row ?? null;
}
