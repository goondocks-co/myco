import type { RelationalStore } from '../../core/adapters.js';
import { CURRENT_EMBEDDING_SOURCES } from '../embedding-sources.js';
import { currentPassedOver } from './passed-over.js';
import { commit, read, readSet, write } from '../index.js';

/** True while a switch stands. Binds nothing. */
export const SWITCH_STANDS_SQL = 'EXISTS (SELECT 1 FROM embedding_switches)';

/** One stored embedding model switch row, as the switch capability reads it. */
interface SwitchRow {
  id: string; provider: string; model: string; endpoint: string | null; model_key: string; from_model_key: string;
  estimated_tokens: number; estimated_sources: number; state: string; reason: string | null; retry_at: number | null; failures: number;
  progressed_at: number; started_at: number; started_by: string;
}

/** What a new switch records. */
interface SwitchStart {
  id: string; provider: string; model: string; endpoint: string | null; modelKey: string; fromModelKey: string;
  estimatedTokens: number; estimatedSources: number; startedAt: number; startedBy: string;
}

const switchRow = read<[], SwitchRow>({ name: 'embedding.switch',
  sql: `SELECT id,provider,model,endpoint,model_key,from_model_key,estimated_tokens,estimated_sources,state,reason,retry_at,failures,progressed_at,started_at,started_by
    FROM embedding_switches WHERE slot='deployment'` });
const insertSwitchRow = write<[string, string, string, string | null, string, string, number, number, number, string, number], { id: string }>({ name: 'embedding.switchInsert',
  sql: `INSERT INTO embedding_switches(slot,id,provider,model,endpoint,model_key,from_model_key,estimated_tokens,estimated_sources,state,reason,progressed_at,started_at,started_by,updated_at)
    VALUES('deployment',?1,?2,?3,?4,?5,?6,?7,?8,'building',NULL,?9,?9,?10,?11) ON CONFLICT(slot) DO NOTHING RETURNING id` });
const pauseRow = write<[string, number, string], { id: string }>({ name: 'embedding.switchPause',
  sql: `UPDATE embedding_switches SET state='paused',reason=?1,retry_at=NULL,updated_at=?2 WHERE slot='deployment' AND id=?3 AND state='building' RETURNING id` });
const waitRow = write<[number, string, number, string], { id: string }>({ name: 'embedding.switchWait',
  sql: `UPDATE embedding_switches SET retry_at=?1,reason=?2,failures=failures+1,updated_at=?3 WHERE slot='deployment' AND id=?4 AND state='building' RETURNING id` });
const progressRow = write<[number, string]>({ name: 'embedding.switchProgress',
  sql: `UPDATE embedding_switches SET progressed_at=?1,retry_at=NULL,reason=NULL,failures=0,updated_at=?1 WHERE slot='deployment' AND id=?2 AND state='building'` });
const resumeRow = write<[number, string], { id: string }>({ name: 'embedding.switchResume',
  sql: `UPDATE embedding_switches SET state='building',reason=NULL,retry_at=NULL,failures=0,updated_at=?1
    WHERE slot='deployment' AND id=?2 AND (state='paused' OR retry_at IS NOT NULL) RETURNING id` });
const deleteRow = write<[string], { id: string }>({ name: 'embedding.switchDelete', sql: `DELETE FROM embedding_switches WHERE slot='deployment' AND id=?1 RETURNING id` });
const holdRecovered = write<[string, number]>({ name: 'embedding.switchHoldRecovered',
  sql: `UPDATE embedding_switches SET state='paused',reason=?1,retry_at=NULL,updated_at=?2 WHERE slot='deployment'` });
const archivedRow = read<[string], { archived_at: number | null }>({ name: 'embedding.projectArchived', sql: 'SELECT archived_at FROM projects WHERE project_id=?1' });

export async function storedSwitch(db: RelationalStore): Promise<SwitchRow | null> {
  const [[row]] = await readSet(db, switchRow.bind());
  return row ?? null;
}
export async function insertStoredSwitch(db: RelationalStore, sw: SwitchStart, now: number): Promise<boolean> {
  const [rows] = await commit(db, insertSwitchRow.bind(sw.id, sw.provider, sw.model, sw.endpoint, sw.modelKey, sw.fromModelKey, sw.estimatedTokens, sw.estimatedSources, sw.startedAt, sw.startedBy, now));
  return rows.results.length === 1;
}
export async function pauseStoredSwitch(db: RelationalStore, id: string, reason: string, now: number): Promise<boolean> {
  const [rows] = await commit(db, pauseRow.bind(reason, now, id));
  return rows.results.length === 1;
}
export async function waitStoredSwitch(db: RelationalStore, id: string, until: number, reason: string, now: number): Promise<boolean> {
  const [rows] = await commit(db, waitRow.bind(until, reason, now, id));
  return rows.results.length === 1;
}
export async function progressStoredSwitch(db: RelationalStore, id: string, now: number): Promise<void> {
  await commit(db, progressRow.bind(now, id));
}
export async function resumeStoredSwitch(db: RelationalStore, id: string, now: number): Promise<boolean> {
  const [rows] = await commit(db, resumeRow.bind(now, id));
  return rows.results.length === 1;
}
export async function deleteStoredSwitch(db: RelationalStore, id: string): Promise<boolean> {
  const [rows] = await commit(db, deleteRow.bind(id));
  return rows.results.length === 1;
}
const switchTable = read<[], { found: number }>({ name: 'embedding.switchTable', sql: "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='embedding_switches'" });
/** Pause whatever switch a recovered copy carries. A copy older than the switch's schema step holds none. */
export async function holdStoredSwitch(db: RelationalStore, reason: string, now: number): Promise<void> {
  const [present] = await readSet(db, switchTable.bind());
  if (present.length === 0) return;
  await commit(db, holdRecovered.bind(reason, now));
}
export async function storedProjectArchived(db: RelationalStore, projectId: string): Promise<boolean> {
  const [[row]] = await readSet(db, archivedRow.bind(projectId));
  return row !== undefined && row.archived_at !== null;
}

/** A Project's model `?2` is active and initialized: its state rows hold every current source there. */
const initialized = (project: string) => `EXISTS (SELECT 1 FROM embedding_models k WHERE k.project_id=${project} AND k.model_key=?2 AND k.active=1 AND k.complete=1)`;
/** A Project's current sources under model `?2` that hold no indexed vector, from its maintained totals. */
const unready = (project: string) => `COALESCE((SELECT SUM(t.n) FROM embedding_model_totals t WHERE t.project_id=${project} AND t.model_key=?2 AND t.state<>'ready'),0)`;
/**
 * A Project's sources without an indexed vector under `?2` that embedding passes over under it, or under every model,
 * at `?3`: read from the current passed-over membership, so the read is bounded by the Project's current passed-over sources.
 */
const passedUnbuilt = (project: string) => `(SELECT COUNT(*) FROM (SELECT DISTINCT o.type,o.record_id FROM (${currentPassedOver('json_array(?2)', '?3', project)}) o) x
  WHERE EXISTS (SELECT 1 FROM embedding_source_state s WHERE s.project_id=${project} AND s.model_key=?2 AND s.type=x.type AND s.record_id=x.record_id AND s.state<>'ready'))`;
/** Source state and passed-over membership are installed and no reset is still retiring what it outdated. */
const STATE_SETTLED = `(SELECT done FROM projection_catchup WHERE projection='embedding_state' AND phase='versions')=1
  AND NOT EXISTS (SELECT 1 FROM projection_catchup WHERE projection='embedding_reset' AND done=0)
  AND (SELECT done FROM projection_catchup WHERE projection='passed_over' AND phase='failures')=1`;
/**
 * A Project that is not archived and still has a source the model `?2` neither holds a vector for nor passes over at
 * `?3`: its model is not initialized while it holds a source to embed, or its unready total exceeds its passed-over
 * unbuilt sources. Per Project a few key seeks, plus its passed-over sources when anything is unready.
 */
const UNACCOUNTED = `SELECT 1 FROM projects p WHERE p.archived_at IS NULL AND (
    (NOT ${initialized('p.project_id')} AND EXISTS (SELECT 1 FROM embedding_eligible_sources e WHERE e.project_id=p.project_id))
    OR (${unready('p.project_id')}>0 AND ${unready('p.project_id')}>${passedUnbuilt('p.project_id')}))`;

/** Switch `?1` still stands and builds, and every source of every Project that is not archived is accounted for under `?2` at `?3`. */
const SOURCES_ACCOUNTED = `EXISTS (SELECT 1 FROM embedding_switches WHERE slot='deployment' AND id=?1 AND state='building')
  AND ${STATE_SETTLED} AND NOT EXISTS (${UNACCOUNTED})`;

/**
 * Every Project that is not archived holds a calibration work row under `?2` that a probe found idle at the revision it
 * now carries, with no deadline passed by `?3`. Any source, receipt, membership or calibration-cursor change after that
 * probe moves the row's revision, so a completion checked before the change refuses. One key seek per Project.
 */
const CALIBRATED = `NOT EXISTS (SELECT 1 FROM projects p WHERE p.archived_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM embedding_work_state w WHERE w.project_id=p.project_id AND w.model_key=?2 AND w.kind='hubness'
      AND w.revision=w.checked_revision AND w.pending=0 AND (w.wake_at IS NULL OR w.wake_at>?3)))`;

/**
 * The condition every statement of a switch's completion carries: its sources are accounted for, read from the
 * maintained totals and passed-over membership rather than the sources, and every Project's calibration under the
 * switch's model has a probe that found it idle at its current work revision. Binds: `switchCompletionParams`.
 */
export const SWITCH_COMPLETION_SQL = `${SOURCES_ACCOUNTED} AND ${CALIBRATED}`;

export const switchCompletionParams = (sw: { id: string; modelKey: string }, now: number): [string, string, number] => [sw.id, sw.modelKey, now];

const accounted = read<[string, string, number], { complete: number }>({ name: 'embedding.switchAccounted', sql: `SELECT ${SOURCES_ACCOUNTED} AS complete` });

/**
 * Whether switch `sw`'s sources are all accounted for at `now`, in one bounded read: the part of its completion that
 * precedes the calibration check. The completing commit asserts this and calibration together.
 */
export async function switchComplete(db: RelationalStore, sw: { id: string; modelKey: string }, now: number): Promise<boolean> {
  const [[row]] = await readSet(db, accounted.bind(...switchCompletionParams(sw, now)));
  return row?.complete === 1;
}

/** Source `s` belongs to a Project that is not archived. */
const COUNTED = 'EXISTS (SELECT 1 FROM projects p WHERE p.project_id=s.project_id AND p.archived_at IS NULL)';
const estimate = read<[number], { sources: number; chars: number }>({ name: 'embedding.switchEstimate',
  sql: `SELECT COUNT(*) AS sources,COALESCE(SUM(CASE WHEN blob_key IS NULL THEN MIN(COALESCE(length(text),0),?1) ELSE ?1 END),0) AS chars
    FROM embedding_sources s WHERE ${COUNTED}` });

/**
 * The sources a new model would read and their characters, a blob-backed plan read up to its prefix of `prefixChars`.
 * It reads every current source: it answers an admin about to start a switch, never a poll.
 */
export async function switchEstimate(db: RelationalStore, prefixChars: number): Promise<{ sources: number; characters: number }> {
  const [[row]] = await readSet(db, estimate.bind(prefixChars));
  return { sources: row?.sources ?? 0, characters: row?.chars ?? 0 };
}

/**
 * Every model whose vectors the search index holds: a model with any receipt not yet confirmed deleted, in any
 * Project. One primary-key seek per Project and model held there; no receipt is read beyond the first of each model.
 */
const held = read<[], { model_key: string }>({ name: 'embedding.heldModels',
  sql: `WITH RECURSIVE held(project_id,model_key) AS (
      SELECT p.project_id,(SELECT r.model_key FROM embedding_receipts r WHERE r.project_id=p.project_id ORDER BY r.model_key LIMIT 1) FROM projects p
      UNION ALL
      SELECT h.project_id,(SELECT r.model_key FROM embedding_receipts r WHERE r.project_id=h.project_id AND r.model_key>h.model_key ORDER BY r.model_key LIMIT 1)
        FROM held h WHERE h.model_key IS NOT NULL)
    SELECT DISTINCT model_key FROM held WHERE model_key IS NOT NULL ORDER BY model_key` });

export async function heldModels(db: RelationalStore): Promise<string[]> {
  const [rows] = await readSet(db, held.bind());
  return rows.map(row => row.model_key);
}

/** A source embedding passes over, as Health and a switch list it: where it is, what it is, and why; `modelKey` is '' when no model can read it. */
export interface PassedOverSource { projectId: string; projectName: string | null; type: string; recordId: string; title: string; modelKey: string; reason: string; recordedAt: number }

/** Passed-over sources under `?1` (or every model) at `?2`, in Projects that are not archived, without a ready vector under `?3` when it is set. */
const membership = `FROM (${currentPassedOver('json_array(?1)', '?2')}) o JOIN projects p ON p.project_id=o.project_id AND p.archived_at IS NULL
  WHERE (?3 IS NULL OR NOT EXISTS (SELECT 1 FROM embedding_source_state s WHERE s.project_id=o.project_id AND s.model_key=?3 AND s.type=o.type AND s.record_id=o.record_id AND s.state='ready'))`;
const SWITCH_PASSED_OVER_SHOWN = 20;
const passedPage = read<[string, number, string | null], PassedOverSource>({ name: 'embedding.switchPassedOverPage',
  sql: `SELECT f.project_id AS projectId,(SELECT name FROM projects WHERE project_id=f.project_id) AS projectName,f.type,f.record_id AS recordId,f.model_key AS modelKey,f.reason,f.at AS recordedAt,
    CASE f.type ${CURRENT_EMBEDDING_SOURCES.map(s => `WHEN '${s.type}' THEN (SELECT ${s.title} FROM ${s.table} WHERE project_id=f.project_id AND ${s.id}=f.record_id)`).join(' ')} END AS title
    FROM (SELECT o.project_id,o.type,o.record_id,o.model_key,o.reason,MAX(o.recorded_at) AS at ${membership}
      GROUP BY o.project_id,o.type,o.record_id ORDER BY at DESC,o.record_id,o.project_id,o.type LIMIT ${SWITCH_PASSED_OVER_SHOWN}) f
    ORDER BY f.at DESC,f.record_id,f.project_id,f.type` });
const passedCount = read<[string, number, string | null], { n: number }>({ name: 'embedding.switchPassedOverCount',
  sql: `SELECT COUNT(*) AS n FROM (SELECT DISTINCT o.project_id,o.type,o.record_id ${membership})` });

const passedReadiness = read<[], { done: number }>({ name: 'embedding.switchPassedOverReadiness',
  sql: "SELECT done FROM projection_catchup WHERE projection='passed_over' AND phase='failures'" });

/**
 * The sources embedding passes over under `model` at `now`, in Projects that are not archived, newest first, at most
 * `SWITCH_PASSED_OVER_SHOWN`, with their count; `unbuiltUnder` keeps to those without a ready vector under that model.
 * Read from the current passed-over membership, so the cost is bounded by the current passed-over sources. `state` is
 * `building` while the membership is still catching up, when the list and count are partial.
 */
export async function switchPassedOver(db: RelationalStore, model: string, now: number, unbuiltUnder: string | null):
Promise<{ state: 'ready' | 'building'; sources: PassedOverSource[]; count: number }> {
  const [phase, sources, [count]] = await readSet(db, passedReadiness.bind(), passedPage.bind(model, now, unbuiltUnder), passedCount.bind(model, now, unbuiltUnder));
  return { state: phase[0]?.done === 1 ? 'ready' : 'building', sources, count: count?.n ?? 0 };
}
