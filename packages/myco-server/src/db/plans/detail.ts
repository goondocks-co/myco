import type { RelationalStore } from '../../core/adapters.js';
import { registeredObjectKeySql } from '../../core/blob-objects.js';
import { processedResourceProofSql } from '../processed-resources.js';
import { notTombstonedSql } from '../session-read-model.js';
import { first, read, write } from '../index.js';
import { PAST_PLAN_STATUSES } from './resolution.js';

/** One plan in full: its body, the object key of a body spilled to a blob once its processing is proven, and its stored progress. */
export interface PlanDetailRow {
  plan_key: string;
  session_id: string;
  prompt_id: string | null;
  title: string | null;
  status: string;
  content: string | null;
  blob_key: string | null;
  object_key: string | null;
  origin_path: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
  preview: string | null;
  progress_done: number | null;
  progress_total: number | null;
  resolution_note: string | null;
  resolved_at: number | null;
  superseded_by: string | null;
  outcome_refs: string | null;
}

export interface PlanSummaryRow { plan_key: string; title: string | null; status: string; session_id: string; content_hash: string | null }

const SHOWN = notTombstonedSql('p');

const DETAIL = read<[project: string, plan: string], PlanDetailRow>({ name: 'planDetail.get',
  sql: `SELECT p.plan_key,p.session_id,p.prompt_id,p.title,p.status,p.content,p.blob_key,
      CASE WHEN ${processedResourceProofSql('p.project_id', 'plan', 'p.plan_key', 'p.blob_key')} THEN ${registeredObjectKeySql('p.project_id', 'p.blob_key')} END AS object_key,
      p.origin_path,p.updated_by,p.created_at,p.updated_at,m.preview,m.progress_done,m.progress_total,
      p.resolution_note,p.resolved_at,p.superseded_by,p.outcome_refs
    FROM plans p LEFT JOIN plan_metadata m ON m.project_id=p.project_id AND m.plan_key=p.plan_key WHERE p.project_id=?1 AND p.plan_key=?2 AND ${SHOWN}` });
const SUMMARY = read<[project: string, plan: string], PlanSummaryRow>({ name: 'planDetail.summary',
  sql: `SELECT p.plan_key,p.title,p.status,p.session_id,p.content_hash FROM plans p WHERE p.project_id=?1 AND p.plan_key=?2 AND ${SHOWN}` });
const IN_SESSION = read<[project: string, session: string, plan: string], { present: number }>({ name: 'planDetail.inSession',
  sql: `SELECT 1 AS present FROM plans p WHERE p.project_id=?1 AND p.session_id=?2 AND p.plan_key=?3 AND ${SHOWN}` });

/** The plan in full, or null when the Project holds no such plan or its session was deleted. */
export const readPlanDetail = (db: RelationalStore, projectId: string, planKey: string): Promise<PlanDetailRow | null> =>
  first(db, DETAIL.bind(projectId, planKey));

/** The plan's bounded metadata, including the content revision and source session. */
export const readPlanSummary = (db: RelationalStore, projectId: string, planKey: string): Promise<PlanSummaryRow | null> =>
  first(db, SUMMARY.bind(projectId, planKey));

/** Whether the plan sits in the session. */
export async function planInSession(db: RelationalStore, projectId: string, sessionId: string, planKey: string): Promise<boolean> {
  return (await first(db, IN_SESSION.bind(projectId, sessionId, planKey))) !== null;
}

/**
 * A plan's status as an administrative edit by a member, stamped strictly after the row so a capture event replayed with
 * the row's old stamp never wins over it. Writes nothing for an unknown plan or one already holding the status. The edit
 * replaces any resolution curation recorded: a past status is resolved at the edit, with no note; a live one is not.
 */
const SET_STATUS = write<[status: string, by: string, now: number, project: string, plan: string], { plan_key: string }>({ name: 'planStatus.set',
  sql: `UPDATE plans SET status=?1,updated_by=?2,updated_at=MAX(updated_at+1,?3),
      resolved_at=CASE WHEN ?1 IN (${PAST_PLAN_STATUSES.map(status => `'${status}'`).join(',')}) THEN MAX(updated_at+1,?3) END,
      resolution_note=NULL,superseded_by=NULL,outcome_refs=NULL
    WHERE project_id=?4 AND plan_key=?5 AND status<>?1 RETURNING plan_key` });

/** True when the edit changed the plan's status. */
export async function writePlanStatus(db: RelationalStore, edit: { projectId: string; planKey: string; status: string; by: string; now: number }): Promise<boolean> {
  return (await first(db, SET_STATUS.bind(edit.status, edit.by, edit.now, edit.projectId, edit.planKey))) !== null;
}
