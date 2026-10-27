import type { PreparedStatement, RelationalStore } from '../core/adapters.js';
import type { ContentUsage } from '../core/content-budget.js';
import type { ViewWriteTarget } from './view-guard.js';
import { viewWriteGuard } from './view-guard.js';
import { PARSER_VERSION } from './parse.js';

const requiredBytes = `(SELECT COALESCE(SUM(MAX(0,t.size-c.start_offset)),0) FROM view_checkpoints c
  JOIN transcripts t ON t.project_id=c.project_id AND t.transcript_id=c.transcript_id
  WHERE c.project_id=view_work_samples.project_id AND c.instance_id=view_work_samples.instance_id)`;

/** One latest-attempt sample per session survives queue removal without retaining an instance. */
export function startViewSample(
  db: RelationalStore,
  project: string,
  session: string,
  instance: string,
): PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT OR REPLACE INTO view_work_samples(project_id,session_id,instance_id,started_at,initial_bytes,offered_bytes)
   SELECT ?,?,?,?,COALESCE(SUM(MAX(0,t.size-c.start_offset)),0),COALESCE(SUM(MAX(0,t.size-c.start_offset)),0)
   FROM view_checkpoints c JOIN transcripts t ON t.project_id=c.project_id AND t.transcript_id=c.transcript_id
   WHERE c.project_id=? AND c.instance_id=?`,
      )
      .bind(project, session, instance, Date.now(), project, instance),
  ];
}

/** Progress is credited before its guarded checkpoint advances, in the same transaction. */
export function viewSampleProgress(
  db: RelationalStore,
  target: ViewWriteTarget,
  transcript: string,
  to: number,
): PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE view_work_samples SET useful_bytes=useful_bytes+COALESCE((SELECT MAX(0,?-parsed_offset)
   FROM view_checkpoints WHERE project_id=? AND instance_id=? AND transcript_id=?),0),offered_bytes=MAX(offered_bytes,${requiredBytes})
   WHERE project_id=? AND session_id=? AND instance_id=? AND published_at IS NULL`,
      )
      .bind(to, target.projectId, target.instanceId, transcript, target.projectId, target.sessionId, target.instanceId),
  ];
}

export function publishViewSample(db: RelationalStore, target: ViewWriteTarget, now: number): PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE view_work_samples SET published_bytes=useful_bytes,published_at=?,offered_bytes=MAX(offered_bytes,${requiredBytes})
   WHERE project_id=? AND session_id=? AND instance_id=?`,
      )
      .bind(now, target.projectId, target.sessionId, target.instanceId),
  ];
}

/** Interrupted or unobserved work invalidates the attempt's performance denominator. */
export async function beginViewSample(
  db: RelationalStore,
  target: ViewWriteTarget,
  store: 'native' | 'remote',
  profile: 'serial' | 'parallel',
  now: number,
): Promise<string> {
  const token = crypto.randomUUID();
  await db.batch([
    ...viewWriteGuard(db, target, now),
    db
      .prepare(
        `UPDATE view_work_samples SET valid=CASE WHEN observation_token IS NOT NULL OR wakes=0 AND useful_bytes>0 THEN 0 ELSE valid END,
   observation_token=?,store=?,profile=? WHERE project_id=? AND session_id=? AND instance_id=?`,
      )
      .bind(token, store, profile, target.projectId, target.sessionId, target.instanceId),
  ]);
  return token;
}

export async function finishViewSample(
  db: RelationalStore,
  target: ViewWriteTarget,
  token: string,
  usage: ContentUsage,
  wakeMs: number,
  serviceMs: number,
  refusal: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE view_work_samples SET observed_at=?,observation_token=NULL,wakes=wakes+1,wake_ms=wake_ms+?,service_ms=service_ms+?,
   statements=statements+?,round_trips=round_trips+?,blob_calls=blob_calls+?,last_refusal=?
   WHERE project_id=? AND session_id=? AND instance_id=? AND observation_token=?
   AND EXISTS(SELECT 1 FROM view_instances i WHERE i.project_id=view_work_samples.project_id AND i.instance_id=view_work_samples.instance_id AND i.parser_version=?)
   AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.project_id=view_work_samples.project_id AND t.session_id=view_work_samples.session_id)`,
    )
    .bind(
      Date.now(),
      wakeMs,
      serviceMs,
      usage.statements + 1,
      usage.roundTrips + 1,
      usage.blobCalls,
      refusal,
      target.projectId,
      target.sessionId,
      target.instanceId,
      token,
      PARSER_VERSION,
    )
    .run();
}
