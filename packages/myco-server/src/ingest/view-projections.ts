import type { PreparedStatement, RelationalStore } from '../core/adapters.js';
import { unreadPromptSql } from '../db/session-read-model.js';
import { READ_ORIGINS } from '../read/extraction-origins.js';
import { resolvePresentedDates } from './projections.js';
import type { ViewRow } from './view-writer.js';
import type { ViewWriteTarget } from './view-guard.js';
import { MATERIALS } from '../db/view-tables.js';

interface Projection {
  sql: string;
  params: unknown[];
}
const materials = MATERIALS;
type Material = keyof typeof materials;
interface ProjectionScope {
  projectId: string;
  sessionId: string;
  instanceId?: string;
}
type PromptSelection = readonly string[] | { relatedTo: string };

/** Operational projections resolve the same fact, live and parent precedence as publication. */
function effectiveMaterial(
  target: ProjectionScope,
  kind: Material,
  fields: readonly string[],
  candidate = false,
  extra?: { fact: string; view: string },
  ids?: PromptSelection,
): Projection {
  if (candidate && target.instanceId === undefined) throw new Error('view_projection_candidate_absent');
  const relatedTo = ids !== undefined && 'relatedTo' in ids ? ids.relatedTo : undefined;
  if (relatedTo !== undefined && kind !== 'prompt') throw new Error('view_projection_selection_invalid');
  const m = materials[kind],
    scopeProject = '(SELECT project FROM view_scope)',
    scopeSession = '(SELECT session FROM view_scope)',
    scopeInstance = '(SELECT instance FROM view_scope)';
  const closure = candidate
    ? {
        sql: `SELECT project_id,instance_id,0 precedence FROM view_instances WHERE project_id=${scopeProject} AND instance_id=${scopeInstance}
    UNION ALL SELECT project_id,parent_instance,1 FROM view_instances WHERE project_id=${scopeProject} AND instance_id=${scopeInstance} AND parent_instance IS NOT NULL`,
        params: [],
      }
    : {
        sql: `SELECT project_id,instance_id,precedence FROM view_visible WHERE project_id=${scopeProject} AND session_id=${scopeSession}`,
        params: [],
      };
  const classification = `NOT EXISTS(SELECT 1 FROM fact_classes f WHERE f.project_id=r.project_id AND f.table_name='${m.fact}' AND f.record_id=r.${m.id} AND f.class='legacy')`;
  const facts = candidate
    ? classification
    : `(NOT EXISTS(SELECT 1 FROM session_views s WHERE s.project_id=r.project_id AND s.session_id=r.session_id AND s.live_instance IS NOT NULL) OR ${classification})`;
  const restriction = ids === undefined ? '' : ` AND r.${m.id}=chosen.id`;
  const related =
    relatedTo === undefined
      ? ''
      : `,related_prompts AS(
   SELECT json_extract(doc,'$.relatedTo') id FROM input UNION
   SELECT p.prompt_id FROM prompt_batches l CROSS JOIN view_visible v CROSS JOIN view_prompts p INDEXED BY idx_view_prompt_source
   WHERE l.project_id=${scopeProject} AND l.session_id=${scopeSession} AND l.prompt_id=(SELECT json_extract(doc,'$.relatedTo') FROM input)
     AND v.project_id=l.project_id AND v.session_id=l.session_id AND p.project_id=v.project_id AND p.instance_id=v.instance_id
     AND p.claim=l.claim AND p.source_key=l.source_key AND p.source_thread=l.source_thread AND p.source_record=l.source_record)`;
  const selected =
    ids === undefined
      ? ''
      : `,selected_ids AS(${relatedTo === undefined ? `SELECT DISTINCT value id FROM json_each((SELECT doc FROM input),'$.ids')` : 'SELECT id FROM related_prompts'})`;
  const driving = ids === undefined ? '' : 'selected_ids chosen CROSS JOIN ';
  const select = fields.map((field) => 'r.' + field).join(',');
  return {
    sql: `WITH input AS(SELECT ? doc),view_scope AS(SELECT json_extract(doc,'$.project') project,json_extract(doc,'$.session') session,json_extract(doc,'$.instance') instance FROM input)${related}${selected},candidates AS (
   SELECT ${select}${extra ? ',' + extra.fact : ''},0 precedence FROM ${driving}${m.fact} r WHERE r.project_id=${scopeProject} AND r.session_id=${scopeSession} AND ${facts}${restriction}
   UNION ALL SELECT ${select}${extra ? ',' + extra.view : ''},v.precedence+1 FROM ${driving}(${closure.sql}) v CROSS JOIN ${m.table} r
     WHERE v.project_id=r.project_id AND v.instance_id=r.instance_id AND r.project_id=${scopeProject} AND r.session_id=${scopeSession}${restriction}),
   ranked AS (SELECT *,row_number() OVER(PARTITION BY ${m.id} ORDER BY precedence) rank FROM candidates)
   SELECT * FROM ranked WHERE rank=1`,
    params: [
      JSON.stringify({
        project: target.projectId,
        session: target.sessionId,
        instance: target.instanceId,
        ids: relatedTo === undefined ? ids : undefined,
        relatedTo,
      }),
    ],
  };
}

const promptProjection = (target: ProjectionScope, ids?: PromptSelection) =>
  effectiveMaterial(
    target,
    'prompt',
    ['prompt_id', 'origin', 'created_at', 'received_at'],
    false,
    {
      fact: `CASE WHEN ${unreadPromptSql('r')} THEN 1 ELSE 0 END unread`,
      view: `CASE WHEN NOT EXISTS(SELECT 1 FROM extraction_acks a WHERE a.project_id=r.project_id AND a.kind='source'
   AND a.source_transcript_id=r.source_transcript_id AND a.source_offset=r.source_offset AND a.source_end=r.source_end) THEN 1 ELSE 0 END unread`,
    },
    ids,
  );

/** The effective-minus-raw unread balance compensates the canonical record-ack trigger exactly once. */
export function viewAcknowledgementBalanceStatements(
  db: RelationalStore,
  project: string,
  session: string,
  prompt: string,
) {
  const effective = promptProjection({ projectId: project, sessionId: session }, { relatedTo: prompt });
  const balance = `(SELECT COUNT(*) FROM (${effective.sql}) WHERE unread=1 AND origin IN (${READ_ORIGINS.map((origin) => `'${origin}'`).join(',')}))
   -(SELECT COUNT(*) FROM prompt_batches raw WHERE raw.project_id=? AND raw.session_id=? AND raw.prompt_id=? AND ${unreadPromptSql('raw')})`;
  const statement = (sign: '+' | '-') =>
    db
      .prepare(
        `UPDATE session_read_facts SET eligible_prompts=eligible_prompts ${sign} (${balance}) WHERE project_id=? AND session_id=?`,
      )
      .bind(...effective.params, project, session, prompt, project, session);
  return { before: [statement('-')], after: [statement('+')] };
}

/** Only a changed effective vector tuple invalidates its current embedding revision. */
export function viewPlanTransitionStatements(db: RelationalStore, target: ViewWriteTarget): PreparedStatement[] {
  const fields = ['plan_key', 'title', 'content', 'blob_key', 'content_hash', 'status', 'session_id', 'created_at'];
  const before = effectiveMaterial(target, 'plan', fields),
    after = effectiveMaterial(target, 'plan', fields, true);
  return [
    db
      .prepare(
        `WITH before AS (${before.sql}),after AS (${after.sql}),ids AS (SELECT plan_key FROM before UNION SELECT plan_key FROM after)
   INSERT INTO embedding_versions(project_id,type,record_id,revision)
   SELECT ?,'plan',ids.plan_key,lower(hex(randomblob(16))) FROM ids LEFT JOIN before b ON b.plan_key=ids.plan_key
     LEFT JOIN after a ON a.plan_key=ids.plan_key WHERE b.plan_key IS NULL OR a.plan_key IS NULL OR ${fields
       .slice(1)
       .map((field) => `b.${field} IS NOT a.${field}`)
       .join(' OR ')}
   ON CONFLICT(project_id,type,record_id) DO UPDATE SET revision=excluded.revision`,
      )
      .bind(...before.params, ...after.params, target.projectId),
  ];
}

/** Current operational counters and lifecycle dates switch with the published closure. */
export function viewSessionProjectionStatements(db: RelationalStore, target: ViewWriteTarget): PreparedStatement[] {
  const prompts = promptProjection(target);
  const bounds = (bound: 'MIN' | 'MAX'): Projection => {
    const dated = (['prompt', 'response', 'tool'] as const).map((kind) =>
      effectiveMaterial(target, kind, [materials[kind].id, 'created_at']),
    );
    return {
      sql: `(SELECT ${bound}(created_at) FROM (${dated.map((source) => `SELECT created_at FROM (${source.sql})`).join(' UNION ALL ')}))`,
      params: dated.flatMap((source) => source.params),
    };
  };
  return [
    db
      .prepare(
        `UPDATE session_read_facts SET eligible_prompts=(SELECT COUNT(*) FROM (${prompts.sql}) WHERE unread=1 AND origin IN (${READ_ORIGINS.map((origin) => `'${origin}'`).join(',')}))
    WHERE project_id=? AND session_id=?`,
      )
      .bind(...prompts.params, target.projectId, target.sessionId),
    db
      .prepare(
        `UPDATE sessions SET ended_at=NULL,ended_by=NULL WHERE project_id=? AND session_id=? AND ended_at IS NOT NULL
    AND ended_at<(SELECT MAX(created_at) FROM (${prompts.sql}) WHERE origin='user')`,
      )
      .bind(target.projectId, target.sessionId, ...prompts.params),
    resolvePresentedDates(db, target.projectId, target.sessionId, undefined, {
      min: bounds('MIN'),
      max: bounds('MAX'),
    }),
  ];
}

/** A live window changes only its named identities and their current projections. */
export function viewLiveProjectionStatements(
  db: RelationalStore,
  target: ViewWriteTarget,
  rows: readonly ViewRow[],
): { before: PreparedStatement[]; after: PreparedStatement[] } {
  const promptIds = rows.filter((row) => row.kind === 'prompt').map((row) => row.recordId);
  const prompts = promptProjection(target, promptIds),
    scope = [target.projectId, target.sessionId];
  const count = `(SELECT COUNT(*) FROM (${prompts.sql}) WHERE unread=1 AND origin IN (${READ_ORIGINS.map((origin) => "'" + origin + "'").join(',')}))`;
  const counter = (sign: '+' | '-') =>
    db
      .prepare(
        `UPDATE session_read_facts SET eligible_prompts=eligible_prompts ${sign} ${count}
   WHERE project_id=? AND session_id=?`,
      )
      .bind(...prompts.params, ...scope);
  const before: PreparedStatement[] = promptIds.length ? [counter('-')] : [],
    after: PreparedStatement[] = promptIds.length ? [counter('+')] : [];
  const plans = rows.filter((row) => row.kind === 'plan');
  if (plans.length) {
    const fields = ['plan_key', 'title', 'content', 'blob_key', 'content_hash', 'status', 'session_id', 'created_at'];
    const old = effectiveMaterial(
      target,
      'plan',
      fields,
      false,
      undefined,
      plans.map((row) => row.recordId),
    );
    before.push(
      db
        .prepare(
          `WITH held AS (${old.sql}),changes AS(SELECT value FROM json_each(?))
    INSERT INTO embedding_versions(project_id,type,record_id,revision)
    SELECT ?,'plan',json_extract(j.value,'$.plan_key'),lower(hex(randomblob(16))) FROM changes j LEFT JOIN held h
      ON h.plan_key=json_extract(j.value,'$.plan_key') WHERE NOT EXISTS(SELECT 1 FROM plans p
      WHERE p.project_id=? AND p.plan_key=json_extract(j.value,'$.plan_key') AND NOT EXISTS(SELECT 1 FROM fact_classes f
        WHERE f.project_id=p.project_id AND f.table_name='plans' AND f.record_id=p.plan_key AND f.class='legacy'))
      AND (h.plan_key IS NULL OR ${fields
        .slice(1)
        .map((field) => `h.${field} IS NOT json_extract(j.value,'$.${field}')`)
        .join(' OR ')})
    ON CONFLICT(project_id,type,record_id) DO UPDATE SET revision=excluded.revision`,
        )
        .bind(
          ...old.params,
          JSON.stringify(plans.map((row) => ({ ...row.values, session_id: target.sessionId }))),
          target.projectId,
          target.projectId,
        ),
    );
  }
  if (rows.length) {
    const bounds = (bound: 'MIN' | 'MAX'): Projection => {
      const sources = (['prompt', 'response', 'tool'] as const).flatMap((kind) => {
        const ids = rows.filter((row) => row.kind === kind).map((row) => row.recordId);
        return ids.length
          ? [effectiveMaterial(target, kind, [materials[kind].id, 'created_at'], false, undefined, ids)]
          : [];
      });
      const field = bound === 'MIN' ? 'occurred_started_at' : 'occurred_ended_at';
      return {
        sql: `(SELECT ${bound}(created_at) FROM (SELECT ${field} created_at FROM sessions WHERE project_id=? AND session_id=?
     ${sources.map((source) => ` UNION ALL SELECT created_at FROM (${source.sql})`).join('')}))`,
        params: [...scope, ...sources.flatMap((source) => source.params)],
      };
    };
    after.push(
      resolvePresentedDates(db, target.projectId, target.sessionId, undefined, {
        min: bounds('MIN'),
        max: bounds('MAX'),
      }),
    );
  }
  if (promptIds.length)
    after.push(
      db
        .prepare(
          `UPDATE sessions SET ended_at=NULL,ended_by=NULL WHERE project_id=? AND session_id=? AND ended_at IS NOT NULL
   AND ended_at<(SELECT MAX(created_at) FROM (${prompts.sql}) WHERE origin='user')`,
        )
        .bind(...scope, ...prompts.params),
    );
  return { before, after };
}
