import type { RelationalStore } from '../../core/adapters.js';
import { notTombstonedSql } from '../session-read-model.js';
import { first, read, readSet, write } from '../index.js';

/**
 * How a plan is resolved: its status, and beside it what resolved it — a note naming what landed, why it was dropped or
 * what is still pending, when it was resolved, the plan that superseded it, and the evidence the decision cited. Plan
 * curation reads stale live plans as one bounded page and writes one decision per plan, bound to the revision it read;
 * a status edit from the plans board replaces a curated resolution.
 */

/** The statuses of a plan still being worked: the ones injection serves and curation reviews. */
export const LIVE_PLAN_STATUSES = ['active', 'in_progress'] as const;
/** The statuses of a past plan. */
export const PAST_PLAN_STATUSES = ['completed', 'abandoned'] as const;

const LIVE = LIVE_PLAN_STATUSES.map((status) => `'${status}'`).join(',');
const PAST = PAST_PLAN_STATUSES.map((status) => `'${status}'`).join(',');

/** Whether the plan aliased `p` is past and carries the instant it was resolved. */
export const planResolvedSql = (p: string): string => `${p}.status IN (${PAST}) AND ${p}.resolved_at IS NOT NULL`;
/** A past plan's outcome in one line: `Completed 2026-11-03: landed #2180`, `Superseded …` or `Abandoned …`. */
export const planOutcomeLineSql = (p: string): string => `CASE WHEN ${p}.status = 'completed' THEN 'Completed' WHEN ${p}.superseded_by IS NOT NULL THEN 'Superseded'
  ELSE 'Abandoned' END || ' ' || date(${p}.resolved_at / 1000, 'unixepoch') || COALESCE(': ' || ${p}.resolution_note, '')`;

/** An abandoned plan's superseding plan and that plan's title, as `superseded_by` and `superseded_by_title`; null for every other plan. */
export const supersededColumnsSql = (p: string): string => `CASE WHEN ${p}.status='abandoned' THEN ${p}.superseded_by END AS superseded_by,
  CASE WHEN ${p}.status='abandoned' AND ${p}.superseded_by IS NOT NULL
    THEN (SELECT s.title FROM plans s WHERE s.project_id=${p}.project_id AND s.plan_key=${p}.superseded_by) END AS superseded_by_title`;

/** The instant a plan last moved for curation: its last edit, or its last review if later. The candidate index is on it. */
const DUE = (p: string) => `MAX(${p}.updated_at, COALESCE(${p}.reviewed_at, 0))`;

/** One stale live plan as curation reads it: what it says of itself, and the session that wrote it. */
export interface PlanCandidateRow {
  plan_key: string;
  session_id: string;
  title: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  preview: string | null;
  progress_done: number | null;
  progress_total: number | null;
  /** The instant it last moved for curation. */
  due_at: number;
}

const CANDIDATES = read<[project: string, status: string, before: number, limit: number], PlanCandidateRow>({ name: 'planCuration.candidates',
  sql: `SELECT p.plan_key,p.session_id,p.title,p.status,p.created_at,p.updated_at,m.preview,m.progress_done,m.progress_total,${DUE('p')} AS due_at
    FROM plans p INDEXED BY idx_plans_curation_due LEFT JOIN plan_metadata m ON m.project_id=p.project_id AND m.plan_key=p.plan_key
    WHERE p.project_id=?1 AND p.status=?2 AND ${DUE('p')}<?3 AND ${notTombstonedSql('p')} ORDER BY ${DUE('p')},p.plan_key LIMIT ?4` });

/**
 * At most `limit` live plans of the Project neither edited nor reviewed before `before`, the longest untouched first:
 * one bounded seek per live status, so the page costs the same however many plans the Project holds.
 */
export async function readPlanCandidates(db: RelationalStore, projectId: string, before: number, limit: number): Promise<PlanCandidateRow[]> {
  const pages = await readSet(db, ...LIVE_PLAN_STATUSES.map((status) => CANDIDATES.bind(projectId, status, before, limit)));
  return pages.flat().sort((a, b) => a.due_at - b.due_at || (a.plan_key < b.plan_key ? -1 : 1)).slice(0, limit);
}

const STALE = read<[project: string, before: number], { present: number }>({ name: 'planCuration.staleExists',
  sql: `SELECT 1 AS present FROM plans p INDEXED BY idx_plans_curation_due
    WHERE p.project_id=?1 AND p.status IN (${LIVE}) AND ${DUE('p')}<?2 AND ${notTombstonedSql('p')} LIMIT 1` });

/** Whether the Project holds a live plan neither edited nor reviewed before `before`. */
export async function stalePlanExists(db: RelationalStore, projectId: string, before: number): Promise<boolean> {
  return (await first(db, STALE.bind(projectId, before))) !== null;
}

/** One pull request, issue, tag, release or deploy a session reported. */
export interface ReportedOutcomeRow { session_id: string; kind: string; artifact_id: string; url: string; reported_at: number }

const OUTCOMES = read<[project: string, sessions: string, since: number, limit: number], ReportedOutcomeRow>({ name: 'planCuration.outcomes',
  sql: `SELECT a.session_id,a.kind,a.artifact_id,a.url,a.reported_at FROM json_each(?2) j
    CROSS JOIN session_artifacts a INDEXED BY idx_session_artifacts_session ON a.project_id=?1 AND a.session_id=j.value AND a.reported_at>=?3
    ORDER BY a.reported_at DESC,a.id LIMIT ?4` });

/** The sessions whose outcomes are one plan's evidence, and the instant the plan was written: only outcomes reported since count. */
export interface OutcomeSessions { sessions: readonly string[]; since: number }

/** The newest `limit` outcomes the sessions of each set reported at or after its instant, one read per set. */
export async function readReportedOutcomes(db: RelationalStore, projectId: string, sets: readonly OutcomeSessions[], limit: number): Promise<ReportedOutcomeRow[][]> {
  if (sets.length === 0) return [];
  return readSet(db, ...sets.map((set) => OUTCOMES.bind(projectId, JSON.stringify(set.sessions), set.since, limit)));
}

const OUTCOME_REPORTER = read<[project: string, sessions: string, kind: string, artifact: string], { session_id: string; reported_at: number }>({
  name: 'planCuration.outcomeReporter',
  sql: `SELECT a.session_id,a.reported_at FROM json_each(?2) j CROSS JOIN session_artifacts a INDEXED BY idx_session_artifacts_identity
    ON a.project_id=?1 AND a.session_id=j.value AND a.kind=?3 AND a.artifact_id=?4 ORDER BY a.reported_at LIMIT 1` });

/** Which of `sessions` reported the artifact `kind`/`artifactId`, and when; null when none of them did. */
export const readOutcomeReporter = (db: RelationalStore, projectId: string, sessions: readonly string[], kind: string, artifactId: string): Promise<{ session_id: string; reported_at: number } | null> =>
  first(db, OUTCOME_REPORTER.bind(projectId, JSON.stringify(sessions), kind, artifactId));

const PLAN_HELD = read<[project: string, plan: string], { plan_key: string; created_at: number }>({ name: 'planCuration.planHeld',
  sql: `SELECT p.plan_key,p.created_at FROM plans p WHERE p.project_id=?1 AND p.plan_key=?2 AND ${notTombstonedSql('p')}` });

/** The plan as a superseding plan is checked: its key and creation instant, or null when the Project holds no such plan. */
export const readPlanHeld = (db: RelationalStore, projectId: string, planKey: string): Promise<{ plan_key: string; created_at: number } | null> =>
  first(db, PLAN_HELD.bind(projectId, planKey));

/** A curation decision as one plan write: the revision it read, and what it sets. */
export interface PlanDecisionWrite {
  projectId: string;
  planKey: string;
  /** The `updated_at` the decision read; a plan edited since is left as it is. */
  revision: number;
  runId: string;
  now: number;
  note: string;
  /** The past status a resolution sets, or null for a plan curation reviewed and left open. */
  status: (typeof PAST_PLAN_STATUSES)[number] | null;
  supersededBy: string | null;
  /** The evidence ids the decision cited, as JSON. */
  evidence: string;
}

/** The curation actor a resolved plan names as its last editor. */
export const CURATION_ACTOR = 'curation';

const RESOLVE = write<[status: string, by: string, now: number, note: string, supersededBy: string | null, evidence: string, run: string,
  project: string, plan: string, revision: number], { plan_key: string }>({ name: 'planCuration.resolve',
  sql: `UPDATE plans SET status=?1,updated_by=?2,updated_at=MAX(updated_at+1,?3),resolved_at=MAX(updated_at+1,?3),resolution_note=?4,superseded_by=?5,
      outcome_refs=?6,reviewed_at=?3,curated_by_run=?7
    WHERE project_id=?8 AND plan_key=?9 AND updated_at=?10 AND status IN (${LIVE})
      AND (?5 IS NULL OR EXISTS (SELECT 1 FROM plans o WHERE o.project_id=?8 AND o.plan_key=?5 AND o.plan_key<>?9))
    RETURNING plan_key` });

const KEEP_OPEN = write<[note: string, now: number, evidence: string, run: string, project: string, plan: string, revision: number], { plan_key: string }>({
  name: 'planCuration.keepOpen',
  sql: `UPDATE plans SET resolution_note=?1,reviewed_at=?2,outcome_refs=?3,curated_by_run=?4
    WHERE project_id=?5 AND plan_key=?6 AND updated_at=?7 AND status IN (${LIVE}) RETURNING plan_key` });

/**
 * One decision, landed only on the plan as it was read: still live, unedited since `revision`, and for a supersession,
 * superseded by another plan the Project holds. A resolution moves the plan's status and edit instant like any status
 * edit; a plan kept open records only its review. True when the plan took the decision.
 */
export async function writePlanDecision(db: RelationalStore, decision: PlanDecisionWrite): Promise<boolean> {
  const d = decision;
  const bound = d.status === null
    ? KEEP_OPEN.bind(d.note, d.now, d.evidence, d.runId, d.projectId, d.planKey, d.revision)
    : RESOLVE.bind(d.status, CURATION_ACTOR, d.now, d.note, d.supersededBy, d.evidence, d.runId, d.projectId, d.planKey, d.revision);
  return (await first(db, bound)) !== null;
}

/** An assigned plan as the run's close reads it back. */
export interface CuratedPlanRow { plan_key: string; status: string; updated_at: number; curated_by_run: string | null; outcome_refs: string | null }

const CURATED = read<[project: string, plans: string], CuratedPlanRow>({ name: 'planCuration.curated',
  sql: `SELECT p.plan_key,p.status,p.updated_at,p.curated_by_run,p.outcome_refs FROM json_each(?2) j
    CROSS JOIN plans p ON p.project_id=?1 AND p.plan_key=j.value` });

/** The assigned plans as they stand, by key; a plan the Project no longer holds is absent. */
export async function readCuratedPlans(db: RelationalStore, projectId: string, planKeys: readonly string[]): Promise<Map<string, CuratedPlanRow>> {
  if (planKeys.length === 0) return new Map();
  const [rows] = await readSet(db, CURATED.bind(projectId, JSON.stringify(planKeys)));
  return new Map(rows.map((row) => [row.plan_key, row]));
}
