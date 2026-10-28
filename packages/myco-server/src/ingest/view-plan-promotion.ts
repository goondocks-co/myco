import type { ServerEnv } from '../core/adapters.js';
import { blobObjectKey } from '../core/blob-objects.js';
import { contentAssertion, readVerifiedContentText } from '../core/registered-content.js';
import { sha256Hex } from '../hash.js';
import type { ReadScope } from '../read/scope.js';
import { releaseViewReadSources } from '../read/view-store.js';

/** A visible view plan becomes the authoritative plan row with its complete body, replacing any legacy row, before an edit applies to it. */
export async function promoteViewPlan(
  env: Pick<ServerEnv, 'db' | 'blobs'>,
  scope: ReadScope,
  key: string,
  now: number,
): Promise<boolean> {
  const db = env.db;
  const plan = await db
    .prepare(
      `SELECT v.*,s.machine_id session_machine,s.created_by_token_id session_token,
      (SELECT f.class FROM fact_classes f WHERE f.project_id=v.project_id AND f.table_name='plans' AND f.record_id=v.plan_key) fact_class,
      EXISTS(SELECT 1 FROM plans p WHERE p.project_id=v.project_id AND p.plan_key=v.plan_key) fact_held,
      (SELECT b.generation FROM blobs b WHERE b.project_id=v.project_id AND b.key=v.blob_key) generation,
      (SELECT c.size FROM view_content_proofs c WHERE c.project_id=v.project_id AND c.instance_id=v.instance_id
        AND c.kind='plan' AND c.record_id=v.plan_key AND c.blob_key=v.blob_key) body_size
    FROM view_plans v JOIN view_visible vv ON vv.project_id=v.project_id AND vv.instance_id=v.instance_id
    JOIN sessions s ON s.project_id=v.project_id AND s.session_id=v.session_id
    WHERE v.project_id=? AND v.plan_key=? ORDER BY vv.precedence LIMIT 1`,
    )
    .bind(scope.projectId, key)
    .first<Record<string, unknown>>();
  if (plan === null || (plan.fact_held === 1 && plan.fact_class !== 'legacy')) return false;
  const promoted = (instance: unknown) => [
    db
      .prepare(
        `INSERT OR REPLACE INTO fact_classes(project_id,table_name,record_id,session_id,class,classified_at) VALUES(?,'plans',?,?,'promoted',?)`,
      )
      .bind(scope.projectId, key, plan.session_id, now),
    db
      .prepare(
        `INSERT OR REPLACE INTO plan_promotions(project_id,plan_key,session_id,instance_id,source_tag,source_coordinate,state,editor,promoted_at,
        source_transcript_id,source_offset,source_end,source_key,source_thread,source_record) VALUES(?,?,?,?,?,?,'done','member',?,?,?,?,?,?,?)`,
      )
      .bind(
        scope.projectId,
        key,
        plan.session_id,
        instance,
        plan.source_tag,
        plan.source_coordinate,
        now,
        plan.source_transcript_id,
        plan.source_offset,
        plan.source_end,
        plan.source_key,
        plan.source_thread,
        plan.source_record,
      ),
  ];
  const content =
    typeof plan.blob_key === 'string'
      ? await readVerifiedContentText(
          env,
          blobObjectKey(scope.projectId, plan.blob_key, (plan.generation as string | null) ?? null),
          Number(plan.body_size),
          plan.blob_key,
        )
      : String(plan.content ?? '');
  const tags = JSON.parse(String(plan.tags_json ?? '[]')) as string[];
  await db.batch([
    db
      .prepare(
        `DELETE FROM tags WHERE project_id=? AND entity_kind='plan' AND entity_id=? AND tag NOT IN(SELECT value FROM json_each(?))`,
      )
      .bind(scope.projectId, key, JSON.stringify(tags)),
    ...tags.map((tag) =>
      db
        .prepare(`INSERT OR IGNORE INTO tags(project_id,entity_kind,entity_id,tag) VALUES(?,'plan',?,?)`)
        .bind(scope.projectId, key, tag),
    ),
  ]);
  const columns = {
    project_id: scope.projectId,
    plan_key: key,
    session_id: plan.session_id,
    event_id: 'view-promotion:' + String(plan.instance_id) + ':' + key,
    machine_id: plan.machine_id ?? plan.session_machine,
    title: plan.title,
    content,
    content_hash: await sha256Hex(content),
    status: plan.status,
    origin_path: plan.origin_path,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    token_id: plan.token_id ?? plan.session_token,
    received_at: plan.received_at,
    prompt_id: plan.prompt_id,
    source: plan.source,
  };
  const inserted = await db.batch([
    ...contentAssertion(
      db,
      `EXISTS(SELECT 1 FROM view_visible WHERE project_id=? AND instance_id=?)
    AND NOT EXISTS(SELECT 1 FROM plans p WHERE p.project_id=? AND p.plan_key=? AND NOT EXISTS(SELECT 1 FROM fact_classes f
      WHERE f.project_id=p.project_id AND f.table_name='plans' AND f.record_id=p.plan_key AND f.class='legacy'))
    AND NOT EXISTS(SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?)`,
      [scope.projectId, plan.instance_id, scope.projectId, key, scope.projectId, plan.session_id],
    ),
    db
      .prepare(
        `INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,content_hash,status,origin_path,
        created_at,updated_at,token_id,received_at,prompt_id,source)
      SELECT json_extract(value,'$.project_id'),json_extract(value,'$.plan_key'),json_extract(value,'$.session_id'),json_extract(value,'$.event_id'),
        json_extract(value,'$.machine_id'),json_extract(value,'$.title'),json_extract(value,'$.content'),json_extract(value,'$.content_hash'),
        json_extract(value,'$.status'),json_extract(value,'$.origin_path'),json_extract(value,'$.created_at'),json_extract(value,'$.updated_at'),
        json_extract(value,'$.token_id'),json_extract(value,'$.received_at'),json_extract(value,'$.prompt_id'),json_extract(value,'$.source')
      FROM json_each(?) WHERE 1
      ON CONFLICT(project_id,plan_key) DO UPDATE SET session_id=excluded.session_id,event_id=excluded.event_id,machine_id=excluded.machine_id,
        title=excluded.title,content=excluded.content,blob_key=NULL,content_hash=excluded.content_hash,status=excluded.status,
        origin_path=excluded.origin_path,created_at=excluded.created_at,updated_at=excluded.updated_at,token_id=excluded.token_id,
        received_at=excluded.received_at,prompt_id=excluded.prompt_id,source=excluded.source,updated_by=NULL`,
      )
      .bind(JSON.stringify([columns])),
    ...promoted(plan.instance_id),
  ]);
  releaseViewReadSources(db);
  return inserted.length > 0;
}
