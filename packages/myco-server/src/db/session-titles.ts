import { TITLE_WORK_RECHECK_MS } from './sessions/title-work.js';
import { commit, readSet, read, write, type Bound } from './index.js';
import { attributedUpdate } from './runs/attribution.js';
import type { RelationalStore } from '../core/adapters.js';
import { commitAttributedWrite } from './runs/attribution.js';
import { titleRunInFlightSql, notTombstonedSql } from './session-read-model.js';
import { type RunWrite } from './runs/evidence.js';
import { sessionMaterialReadySql, titlingClaimAvailableSql, transcriptsPublishedSql } from './sessions/material.js';
import { SQL_NOW_MS } from '../core/run-deadline.js';
import { contextValue } from './run-context.js';
import { PROVIDER_FAULTS } from '../core/completion/provider.js';

const stamp = read<[string, string], { titled_at: number | null }>({ name: 'sessionTitle.stamp', sql: 'SELECT titled_at FROM sessions WHERE project_id = ? AND session_id = ?' });
const claimAutomatic = write<[number, string, string, number | null, number, number | null], { session_id: string }>({ name: 'sessionTitle.claimAutomatic', sql: `UPDATE sessions SET titled_at = ? WHERE project_id = ? AND session_id = ? AND titled_at IS ? AND (ended_at IS NOT NULL OR last_received_at <= ?) AND ${titlingClaimAvailableSql('sessions')} AND ${sessionMaterialReadySql('sessions')} RETURNING session_id` });
const claimRefresh = write<[number, string, string, number, number], { session_id: string }>({ name: 'sessionTitle.claimRefresh', sql: `UPDATE sessions SET titled_at = ?, title_material_at = COALESCE(title_material_at, titled_at) WHERE project_id = ? AND session_id = ? AND titled_at = ? AND titled_at <= ? AND title IS NOT NULL AND last_received_at > COALESCE(title_material_at, titled_at)
      AND NOT ${titleRunInFlightSql('sessions')} AND ${sessionMaterialReadySql('sessions')} RETURNING session_id` });
const claimOwner = write<[number, string, string, number], { session_id: string }>({ name: 'sessionTitle.claimOwner', sql: `UPDATE sessions SET titled_at = ?, title_material_at = CASE WHEN title IS NULL THEN title_material_at ELSE COALESCE(title_material_at, titled_at) END WHERE project_id = ? AND session_id = ? AND (titled_at IS NULL OR titled_at < ?) AND ${sessionMaterialReadySql('sessions')} RETURNING session_id` });
const restore = write<[number | null, string, string, number], never>({ name: 'sessionTitle.restore', sql: `UPDATE sessions SET titled_at = ? WHERE project_id = ? AND session_id = ? AND titled_at = ?` });

const storeTitle = attributedUpdate<[project: string, session: string, title: string, summary: string, mode: string, by: string | null,
  material: number | null, run: string | null, stamp: number | null, generation: number | null]>(
  'sessionTitle.store', 'sessions',
  `title=?3,summary=?4,titling_attempts=0,titled_by=CASE WHEN ?5='first' THEN titled_by ELSE ?6 END,title_material_at=COALESCE(?7,titled_at,${SQL_NOW_MS})`,
  `project_id=?1 AND session_id=?2 AND (?5='overwrite' OR title IS NULL) AND ${notTombstonedSql('sessions')}
    AND ((?8 IS NULL AND ${transcriptsPublishedSql('sessions')}) OR (?8 IS NOT NULL AND titled_at=?9
      AND EXISTS(SELECT 1 FROM session_documents d WHERE d.project_id=?1 AND d.session_id=?2 AND d.generation=?10 AND d.state='live')
      AND EXISTS(SELECT 1 FROM agent_runs r WHERE r.project_id=?1 AND r.id=?8 AND r.provider='direct' AND r.status='running')))`,
  'session_id', `project_id=?1 AND session_id=?2 AND title IS ?3 AND summary IS ?4 AND (?5='first' OR titled_by IS ?6)`);
const titledPrompts = write<[project: string, session: string, generation: number | null, prompts: number | null], never>({
  name: 'sessionTitle.titledPrompts', sql: `UPDATE session_documents SET titled_user_prompts=CASE WHEN ?4 IS NULL THEN user_prompts
    ELSE MAX(COALESCE(titled_user_prompts,0),MIN(user_prompts,?4)) END
    WHERE project_id=?1 AND session_id=?2 AND state='live' AND (?3 IS NULL OR generation=?3)`,
});

export interface SessionTitleWrite {
  projectId: string;
  sessionId: string;
  title: string;
  summary: string;
  mode: 'first' | 'overwrite';
  by: string | null;
  attribution?: RunWrite;
  observed?: { runId: string; stamp: number; generation: number; instructionPrompts: number; materialAt: number };
  after?: readonly Bound[];
}

/** One writer owns title guards, attribution and the prompts covered by the material used. */
export async function storeSessionTitle(db: RelationalStore, request: SessionTitleWrite): Promise<boolean> {
  const { projectId, sessionId, title, summary, mode, by, observed } = request;
  const result = await commitAttributedWrite(db, { projectId },
    storeTitle.bind(projectId, sessionId, title, summary, mode, by, observed?.materialAt ?? null, observed?.runId ?? null, observed?.stamp ?? null, observed?.generation ?? null),
    request.attribution, [titledPrompts.bind(projectId, sessionId, observed?.generation ?? null, observed?.instructionPrompts ?? null), ...(request.after ?? [])]);
  return result.results.length > 0;
}

/** The session's titling stamp as it stands, or null when the project holds no such session. */
const titlingStamp = (db: RelationalStore, projectId: string, sessionId: string) =>
  readSet(db, stamp.bind(projectId, sessionId)).then(([rows]) => rows[0] ?? null);

/**
 * Claims the first automatic attempt on a session that has ended or, given `idleBefore`, gone quiet (its last receipt at or before
 * that instant), or, given `retryBefore`, a retry of one that ended untitled with its stamp before that instant; null admits a
 * first attempt only. Answers the stamp it replaced, so an attempt that never launches can put exactly that back.
 */
export async function claimTitling(db: RelationalStore, projectId: string, sessionId: string, nowMs: number, retryBefore: number | null, idleBefore: number | null = null): Promise<{ claimed: boolean; previous: number | null }> {
  const row = await titlingStamp(db, projectId, sessionId);
  if (row === null) return { claimed: false, previous: null };
  const previous = row.titled_at ?? null;
  const [result] = await commit(db, claimAutomatic.bind(nowMs, projectId, sessionId, previous, idleBefore ?? 0, retryBefore));
  return { claimed: result.results.length === 1, previous };
}

/**
 * Claims the refresh of a titled session, open or ended: its title stamped at or before `refreshBefore`, a later receipt, and no
 * title run of it in flight. Stamps `titled_at`, which holds the next refresh off for the interval and leaves `title_material_at`,
 * the material of the standing title, where it is; answers the stamp it replaced so an attempt that never launches can put it back.
 */
export async function claimRefreshTitling(db: RelationalStore, projectId: string, sessionId: string, nowMs: number, refreshBefore: number): Promise<{ claimed: boolean; previous: number | null }> {
  const row = await titlingStamp(db, projectId, sessionId);
  if (row === null || row.titled_at === null) return { claimed: false, previous: null };
  const [result] = await commit(db, claimRefresh.bind(nowMs, projectId, sessionId, row.titled_at, refreshBefore));
  return { claimed: result.results.length === 1, previous: row.titled_at };
}

/**
 * Claims a titling attempt an owner asked for: any session, ended or not, titled or not. Refused while an attempt begun within `inFlightMs` may still be running, so two asks make one run. Stamps `titled_at`, and answers the stamp it replaced so an attempt that never launches can put it back.
 */
export async function claimOwnerTitling(db: RelationalStore, projectId: string, sessionId: string, nowMs: number, inFlightMs: number): Promise<{ claimed: boolean; previous: number | null }> {
  const row = await titlingStamp(db, projectId, sessionId);
  if (row === null) return { claimed: false, previous: null };
  const [result] = await commit(db, claimOwner.bind(nowMs, projectId, sessionId, nowMs - inFlightMs));
  return { claimed: result.results.length === 1, previous: row.titled_at ?? null };
}

/** Puts back the stamp a claim replaced, for an attempt whose launch the runtime refused — the session keeps its own end-of-session attempt, and an owner may ask again at once. */
export async function restoreTitlingStamp(db: RelationalStore, projectId: string, sessionId: string, stamp: number, previous: number | null): Promise<void> {
  await commit(db, restore.bind(previous, projectId, sessionId, stamp));
}


/** Stores a session's title and summary over the standing values, naming the member whose ask produced them. */
export async function overwriteTitle(db: RelationalStore, projectId: string, sessionId: string, title: string, summary: string, titledBy: string | null, attribution?: RunWrite): Promise<boolean> {
  return storeSessionTitle(db, { projectId, sessionId, title, summary, mode: 'overwrite', by: titledBy, ...(attribution === undefined ? {} : { attribution }) });
}

/** Stores a session's title and summary where none exists yet; false when one already does. */
export async function writeTitle(db: RelationalStore, projectId: string, sessionId: string, title: string, summary: string, attribution?: RunWrite): Promise<boolean> {
  return storeSessionTitle(db, { projectId, sessionId, title, summary, mode: 'first', by: null, ...(attribution === undefined ? {} : { attribution }) });
}


type Release = 'uncalled' | 'faulted';
const FAULT_CODES = PROVIDER_FAULTS.map(code => `'completion_${code}'`).join(',');
/** How far back a session's provider faults lengthen its next wait. */
const FAULT_MEMORY_MS = 86_400_000;
/** The run still open: before any provider call for an uncalled release, at any point for a faulted one. */
const held = (kind: Release, project: string, run: string) => `EXISTS(SELECT 1 FROM agent_runs r WHERE r.project_id=${project} AND r.id=${run}
  AND r.provider='direct' AND r.status='running'${kind === 'faulted' ? '' : ` AND NOT EXISTS(SELECT 1 FROM agent_run_events e
    WHERE e.project_id=r.project_id AND e.run_id=r.id AND e.event_type='direct_call')`})`;
/** An uncalled attempt looks again after one recheck; a faulted one waits twice as long for each fault the session met in the last day, up to 256 rechecks. */
const wait = (kind: Release, project: string, session: string, now: string) => kind === 'uncalled' ? `${now}+${TITLE_WORK_RECHECK_MS}`
  : `${now}+${TITLE_WORK_RECHECK_MS}*(1<<MIN(8,(SELECT COUNT(*) FROM agent_runs WHERE project_id=${project} AND ${contextValue('session_id')}=${session}
      AND provider='direct' AND status='failed' AND error_code IN (${FAULT_CODES}) AND started_at>${now}-${FAULT_MEMORY_MS})))`;
const releases = (kind: Release) => ({
  uncount: write<[project: string, session: string, stamp: number, run: string], never>({ name: `sessionTitle.uncount.${kind}`, sql: `
    UPDATE sessions SET titling_attempts=MAX(0,titling_attempts-1) WHERE project_id=?1 AND session_id=?2 AND titled_at=?3
      AND ${held(kind, '?1', '?4')} AND EXISTS(SELECT 1 FROM agent_runs WHERE project_id=?1 AND id=?4 AND attempt_counted=1)` }),
  restore: write<[project: string, session: string, stamp: number, previous: number | null, run: string], never>({ name: `sessionTitle.restore.${kind}`, sql: `
    UPDATE sessions SET titled_at=?4 WHERE project_id=?1 AND session_id=?2 AND titled_at=?3 AND ${held(kind, '?1', '?5')}` }),
  defer: write<[project: string, session: string, mode: string, run: string, now: number], never>({ name: `sessionTitle.defer.${kind}`, sql: `
    UPDATE session_title_work SET ready=0,waits='timer',due_at=${wait(kind, '?1', '?2', '?5')},checks=checks+1
      WHERE project_id=?1 AND session_id=?2 AND (mode=?3 OR ?3='owner') AND ${held(kind, '?1', '?4')}` }),
  unmark: write<[project: string, run: string], never>({ name: `sessionTitle.unmark.${kind}`, sql: `
    UPDATE agent_runs SET attempt_counted=0 WHERE project_id=?1 AND id=?2 AND ${held(kind, '?1', '?2')}` }),
});
const RELEASES = { uncalled: releases('uncalled'), faulted: releases('faulted') };

export interface TitleRelease { project: string; session: string; run: string; stamp: number; previous: number | null; mode: string; now: number }
const release = (kind: Release, ask: TitleRelease): Bound[] => {
  const { uncount, restore: restoreStamp, defer, unmark } = RELEASES[kind];
  return [uncount.bind(ask.project, ask.session, ask.stamp, ask.run), restoreStamp.bind(ask.project, ask.session, ask.stamp, ask.previous, ask.run),
    defer.bind(ask.project, ask.session, ask.mode, ask.run, ask.now), unmark.bind(ask.project, ask.run)];
};

/** An uncalled rate-limited attempt gives back its claim and sleeps before the same commit ends its run. */
export const uncalledTitleRelease = (ask: TitleRelease): Bound[] => release('uncalled', ask);

/**
 * An attempt the provider failed gives back its claim and its count: the fault says nothing about the session, so it
 * never spends one of the session's attempts. The session sleeps longer after each fault before it is tried again.
 */
export const faultedTitleRelease = (ask: TitleRelease): Bound[] => release('faulted', ask);
