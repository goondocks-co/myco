import type { PreparedStatement, RelationalStore } from './adapters.js';
import { contentAssertion } from './registered-content.js';
import { NOT_TOMBSTONED_PARAMS } from './tombstones.js';
import { VIEW_MATERIALS } from '../db/view-tables.js';

export const VIEW_HASH_SCHEME = 'view-content-v1';
export interface MaterialVersion {
  kind: string;
  identity: string;
  recordId: string;
  hash: string;
  owner?: 'view' | 'fact';
}
type VersionCandidates =
  | readonly MaterialVersion[]
  | { instanceId: string }
  | { items: readonly MaterialVersion[]; when: { sql: string; params: readonly unknown[] } };

/** Authoritative records retain their admitted identity under exact binding evidence. */
export async function readFactVersion(
  db: RelationalStore,
  project: string,
  session: string,
  kind: string,
  recordId: string,
) {
  const current = await db
    .prepare(
      `SELECT identity,content_hash,hash_scheme,material_seq FROM material_versions
    WHERE project_id=? AND session_id=? AND kind=? AND record_id=? AND owner='fact'`,
    )
    .bind(project, session, kind, recordId)
    .first<{ identity: string; content_hash: string; hash_scheme: string; material_seq: number }>();
  return {
    identity: current?.identity ?? JSON.stringify(['fact', kind, recordId]),
    evidence: {
      sql:
        current === null
          ? `NOT EXISTS(SELECT 1 FROM material_versions WHERE project_id=? AND session_id=? AND kind=? AND record_id=? AND owner='fact')`
          : `EXISTS(SELECT 1 FROM material_versions WHERE project_id=? AND session_id=? AND kind=? AND record_id=? AND owner='fact'
        AND identity=? AND content_hash=? AND hash_scheme=? AND material_seq=?)`,
      params: [
        project,
        session,
        kind,
        recordId,
        ...(current === null
          ? []
          : [current.identity, current.content_hash, current.hash_scheme, current.material_seq]),
      ],
    },
  };
}

/** Decisions and counter allocation are evaluated inside their caller's transaction. */
export function publicationVersionStatements(
  db: RelationalStore,
  project: string,
  session: string,
  attempt: string,
  materials: VersionCandidates,
  replace: boolean,
): PreparedStatement[] {
  const when = 'when' in materials ? materials.when : { sql: '1', params: [] };
  const items = 'items' in materials ? materials.items : materials;
  const source =
    'instanceId' in materials
      ? {
          sql: `WITH closure AS(SELECT project_id,instance_id,0 precedence FROM view_instances WHERE project_id=? AND instance_id=?
      UNION ALL SELECT project_id,parent_instance,1 FROM view_instances WHERE project_id=? AND instance_id=? AND parent_instance IS NOT NULL)
      , material AS (${VIEW_MATERIALS.map(
        (m, rank) => `SELECT '${m.kind}' kind,r.canonical_identity identity,r.${m.id} record_id,
        r.view_content_hash hash,'view' owner,c.precedence,cp.ordinal,r.source_offset,${rank} kind_rank
        FROM closure c JOIN ${m.table} r ON r.project_id=c.project_id AND r.instance_id=c.instance_id
        LEFT JOIN view_checkpoints cp ON cp.project_id=r.project_id AND cp.instance_id=(SELECT instance_id FROM closure WHERE precedence=0) AND cp.transcript_id=r.source_transcript_id
        WHERE NOT EXISTS(SELECT 1 FROM ${m.fact} f WHERE f.project_id=r.project_id AND f.${m.id}=r.${m.id}
          AND NOT EXISTS(SELECT 1 FROM fact_classes fc WHERE fc.project_id=f.project_id AND fc.table_name='${m.fact}' AND fc.record_id=f.${m.id} AND fc.class='legacy'))
        AND NOT EXISTS(SELECT 1 FROM closure n JOIN ${m.table} newer ON newer.project_id=n.project_id AND newer.instance_id=n.instance_id
          WHERE n.precedence<c.precedence AND newer.${m.id}=r.${m.id})`,
      ).join(' UNION ALL ')})
      SELECT kind,identity,record_id,hash,owner,row_number() OVER(ORDER BY ordinal,source_offset,kind_rank,record_id) ord FROM material`,
          params: [project, materials.instanceId, project, materials.instanceId],
        }
      : {
          sql: `SELECT json_extract(value,'$.kind') kind,json_extract(value,'$.identity') identity,json_extract(value,'$.recordId') record_id,
      json_extract(value,'$.hash') hash,COALESCE(json_extract(value,'$.owner'),'view') owner,CAST(key AS INTEGER) ord FROM json_each(?) WHERE (${when.sql})`,
          params: [JSON.stringify(items), ...when.params],
        };
  const scope = [project, session, attempt];
  return [
    ...contentAssertion(db, NOT_TOMBSTONED_PARAMS, [project, session], when),
    db
      .prepare(`INSERT OR IGNORE INTO learning_sessions(project_id,session_id) SELECT ?,? WHERE (${when.sql})`)
      .bind(project, session, ...when.params),
    db
      .prepare(`DELETE FROM view_publication_material WHERE project_id=? AND session_id=? AND attempt_id=?`)
      .bind(...scope),
    db
      .prepare(
        `WITH candidates AS MATERIALIZED (${source.sql})
      INSERT INTO view_publication_material(project_id,session_id,attempt_id,kind,identity,record_id,content_hash,hash_scheme,owner,ord,material_seq)
      SELECT ?,?,?,j.kind,j.identity,j.record_id,j.hash,?,j.owner,j.ord,v.material_seq FROM candidates j LEFT JOIN material_versions v
        ON v.project_id=? AND v.session_id=? AND v.kind=j.kind AND v.identity=j.identity AND v.content_hash=j.hash AND v.hash_scheme=?`,
      )
      .bind(...source.params, ...scope, VIEW_HASH_SCHEME, project, session, VIEW_HASH_SCHEME),
    db
      .prepare(
        `WITH fresh AS MATERIALIZED (
      SELECT kind,identity,row_number() OVER(ORDER BY ord,kind,identity) n FROM view_publication_material
      WHERE project_id=? AND session_id=? AND attempt_id=? AND material_seq IS NULL)
      UPDATE view_publication_material SET material_seq=(
      SELECT l.next_seq+f.n-1 FROM learning_sessions l CROSS JOIN (
        SELECT * FROM fresh) f
      WHERE l.project_id=? AND l.session_id=? AND f.kind=view_publication_material.kind AND f.identity=view_publication_material.identity)
      WHERE project_id=? AND session_id=? AND attempt_id=? AND material_seq IS NULL`,
      )
      .bind(...scope, project, session, ...scope),
    db
      .prepare(
        `UPDATE learning_sessions SET next_seq=MAX(next_seq,COALESCE((SELECT MAX(material_seq)+1
      FROM view_publication_material WHERE project_id=? AND session_id=? AND attempt_id=?),next_seq)),
      max_seq=MAX(max_seq,COALESCE((SELECT MAX(material_seq) FROM view_publication_material WHERE project_id=? AND session_id=? AND attempt_id=?),max_seq)),
      revision=revision+CASE WHEN EXISTS(SELECT 1 FROM view_publication_material p LEFT JOIN material_versions v
        ON v.project_id=p.project_id AND v.session_id=p.session_id AND v.kind=p.kind AND v.identity=p.identity
        WHERE p.project_id=? AND p.session_id=? AND p.attempt_id=? AND
          (v.material_seq IS NOT p.material_seq OR v.content_hash IS NOT p.content_hash OR v.hash_scheme IS NOT p.hash_scheme))
        OR ?=1 AND EXISTS(SELECT 1 FROM material_versions v WHERE v.project_id=? AND v.session_id=? AND v.owner='view'
          AND NOT EXISTS(SELECT 1 FROM view_publication_material p WHERE p.project_id=v.project_id AND p.session_id=v.session_id
            AND p.attempt_id=? AND p.kind=v.kind AND p.identity=v.identity)) THEN 1 ELSE 0 END
      WHERE project_id=? AND session_id=? AND (${when.sql})`,
      )
      .bind(...scope, ...scope, ...scope, replace ? 1 : 0, project, session, attempt, project, session, ...when.params),
    ...(replace
      ? [
          db
            .prepare(
              `DELETE FROM material_versions WHERE project_id=? AND session_id=? AND owner='view' AND (${when.sql}) AND NOT EXISTS(
      SELECT 1 FROM view_publication_material p WHERE p.project_id=? AND p.session_id=? AND p.attempt_id=?
        AND p.kind=material_versions.kind AND p.identity=material_versions.identity)`,
            )
            .bind(project, session, ...when.params, ...scope),
        ]
      : []),
    db
      .prepare(
        `INSERT INTO material_versions(project_id,session_id,kind,identity,record_id,content_hash,hash_scheme,owner,material_seq)
      SELECT project_id,session_id,kind,identity,record_id,content_hash,hash_scheme,owner,material_seq FROM view_publication_material
      WHERE project_id=? AND session_id=? AND attempt_id=? AND 1
      ON CONFLICT(project_id,session_id,kind,identity) DO UPDATE SET record_id=excluded.record_id,
        content_hash=excluded.content_hash,hash_scheme=excluded.hash_scheme,owner=excluded.owner,material_seq=excluded.material_seq
      WHERE material_versions.owner='view' OR excluded.owner='fact'`,
      )
      .bind(...scope),
  ];
}

export function finishVersionStatements(
  db: RelationalStore,
  project: string,
  session: string,
  attempt: string,
): PreparedStatement[] {
  return [
    db
      .prepare(`DELETE FROM view_publication_material WHERE project_id=? AND session_id=? AND attempt_id=?`)
      .bind(project, session, attempt),
  ];
}
