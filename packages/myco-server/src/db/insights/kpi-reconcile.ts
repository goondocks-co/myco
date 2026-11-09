import { write } from '../index.js';
import { jsonKeys } from '../ddl.js';

export const KPI_DAY_MS = 86_400_000;
export const KPI_MEASURES = [
  'prompts', 'served', 'with_spores', 'claimed', 'unrecognized', 'unmarked', 'opener_conflict',
  'contract_violation', 'reused', 'calls', 'plan_reads', 'sessions', 'started_with_block',
  'deliveries', 'placed', 'identity_conflicts', 'duplicate_skips', 'scheme_conflicts', 'mixed_sessions',
] as const;
export type KpiMeasure = typeof KPI_MEASURES[number];
export type KpiGrain = 'p' | 'c' | 's' | 'd' | 'i' | 'a' | 't' | 'm';

const sameSession = (a: string, b: string) => `${a}.project_id=${b}.project_id AND ${a}.session_id=${b}.session_id`;
const live = (a: string, session: string) => `${a}.generation=(SELECT doc.generation FROM session_documents doc WHERE ${sameSession('doc', session)} AND doc.state='live')`;
export const harnessOf = (a: string) => `COALESCE((SELECT tr.agent FROM transcripts tr INDEXED BY idx_transcripts_session WHERE ${sameSession('tr', a)} AND tr.role='primary' ORDER BY tr.first_received_at,tr.transcript_id LIMIT 1),'unrecorded')`;
const dayOf = (time: string) => `CAST((${time} - ((${time} % ${KPI_DAY_MS} + ${KPI_DAY_MS}) % ${KPI_DAY_MS})) / ${KPI_DAY_MS} AS INTEGER)`;
const conflictColumns = ['prompt_id', 'source_key', 'source_thread', 'source_record'];
export const conflictKey = (a: string) => `json_array(${conflictColumns.map(c => `${a}.${c}`).join(',')})`;

interface GrainSource {
  table: string;
  key: string;
  match: string;
  eligible: string;
  time: string;
  harness?: string;
  measures: Partial<Record<KpiMeasure, string>>;
}
const delivered = `SELECT 1 FROM spore_injections r WHERE ${sameSession('r', 'x')} AND r.delivered_prompt_id=x.prompt_id AND r.delivered_at IS NOT NULL`;
const mixedTime = `(SELECT MAX(tr.first_received_at) AS newest FROM transcripts tr INDEXED BY idx_transcripts_session
  WHERE ${sameSession('tr', 'q')} AND tr.agent=q.k AND tr.prompt_identity_scheme IS NOT NULL
  GROUP BY tr.prompt_identity_scheme ORDER BY newest DESC LIMIT 1 OFFSET 1)`;
const sources: Record<KpiGrain, GrainSource> = {
  p: { table: 'session_prompts', key: 'x.prompt_id', match: 'x.prompt_id=q.k', eligible: live('x', 'q'), time: 'x.created_at', measures: {
    prompts: '1', served: `(EXISTS (${delivered}) OR EXISTS (SELECT 1 FROM session_injections r WHERE ${sameSession('r', 'x')} AND r.kind='plan-nudge' AND r.delivered_prompt_id=x.prompt_id AND r.delivered_at IS NOT NULL))`,
    with_spores: `EXISTS (${delivered} AND r.spore_ids<>'[]')`, claimed: 'x.claim IS NOT NULL',
    ...Object.fromEntries(['unrecognized', 'unmarked', 'opener_conflict', 'contract_violation'].map(k => [k, `(x.claim IS NOT NULL AND x.prompt_kind='${k}')`])),
    reused: `COALESCE(x.claim='reused',0)`,
  } },
  c: { table: 'myco_tool_calls', key: 'x.tool_call_id', match: 'x.tool_call_id=q.k', eligible: `${live('x', 'q')} AND x.myco_tool IS NOT NULL`, time: 'x.created_at', measures: {
    calls: '1', plan_reads: `(x.myco_tool='myco_plans' AND (x.myco_op IS NULL OR x.myco_op IN ('list','get')))`,
  } },
  s: { table: 'sessions', key: "''", match: "q.k=''", eligible: '1', time: 'x.first_received_at', measures: {
    sessions: '1', started_with_block: `EXISTS (SELECT 1 FROM session_injections r WHERE ${sameSession('r', 'x')} AND r.kind='cortex')`,
  } },
  d: { table: 'spore_injections', key: 'x.id', match: 'x.id=q.k', eligible: 'x.delivered_at IS NOT NULL', time: 'x.delivered_at', measures: {
    deliveries: '1', placed: `EXISTS (SELECT 1 FROM session_prompts p WHERE ${sameSession('p', 'x')} AND p.prompt_id=x.delivered_prompt_id AND ${live('p', 'x')})`,
  } },
  i: { table: 'prompt_identity_conflicts', key: conflictKey('x'), match: conflictColumns.map((c, i) => `x.${c}=json_extract(q.k,'$[${i}]')`).join(' AND '), eligible: '1', time: 'x.created_at', measures: { identity_conflicts: '1' } },
  a: { table: 'prompt_context_answers', key: 'x.id', match: 'x.id=q.k', eligible: `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(x.skipped) THEN x.skipped ELSE '[]' END) WHERE value='spores:duplicate_prompt')`, time: 'x.created_at', measures: { duplicate_skips: '1' } },
  t: { table: 'transcripts', key: 'x.transcript_id', match: 'x.transcript_id=q.k', eligible: 'x.prompt_identity_scheme IS NULL', time: 'x.first_received_at', harness: `COALESCE(x.agent,'')`, measures: { scheme_conflicts: '1' } },
  m: { table: 'transcripts', key: 'x.agent', match: 'x.agent=q.k', eligible: `${mixedTime} IS NOT NULL`, time: mixedTime, harness: 'q.k', measures: { mixed_sessions: '1' } },
};

function eligibleKpi(grain: KpiGrain, from: string, key = 'q.k'): string {
  const source = sources[grain];
  return `SELECT q.project_id,q.session_id,${key} AS key,${dayOf(source.time)} AS day,${source.harness ?? harnessOf('x')} AS harness,
    ${KPI_MEASURES.map(c => `${source.measures[c] ?? '0'} AS ${c}`).join(',')} FROM ${from} WHERE ${source.eligible}`;
}

function upsertKpi(grain: KpiGrain, eligible: string): string {
  const values = ['day', 'harness', ...KPI_MEASURES];
  return `INSERT INTO kpi_fact(project_id,session_id,grain,key,${values.join(',')})
      SELECT project_id,session_id,'${grain}',key,${values.join(',')} FROM (${eligible}) WHERE true
      ON CONFLICT(project_id,session_id,grain,key) DO UPDATE SET (${values.join(',')})=(${values.map(c => `excluded.${c}`).join(',')})
      WHERE (${values.map(c => `kpi_fact.${c}`).join(',')}) IS NOT (${values.map(c => `excluded.${c}`).join(',')})`;
}

/** Keys contain project_id, session_id and k; source values are read at execution. */
export function reconcileKpi(grain: KpiGrain, keys: string): string[] {
  const source = sources[grain];
  const from = grain === 'm' ? `(${keys}) q` : `(${keys}) q JOIN ${source.table} x ON ${sameSession('x', 'q')} AND ${source.match}`;
  const eligible = eligibleKpi(grain, from);
  return [
    `DELETE FROM kpi_fact WHERE grain='${grain}' AND (project_id,session_id,key) IN (SELECT project_id,session_id,k FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM (${eligible}) e WHERE e.project_id=kpi_fact.project_id AND e.session_id=kpi_fact.session_id AND e.key=kpi_fact.key)`,
    upsertKpi(grain, eligible),
  ];
}

export function sessionKeys(grain: KpiGrain, sessions: string): string {
  const source = sources[grain];
  return `SELECT x.project_id,x.session_id,${source.key} AS k FROM (${sessions}) s JOIN ${source.table} x ON ${sameSession('x', 's')}
    UNION SELECT f.project_id,f.session_id,f.key AS k FROM (${sessions}) s JOIN kpi_fact f ON ${sameSession('f', 's')} WHERE f.grain='${grain}'`;
}

const earliestReceipt = (a: string) => `(SELECT MIN(created_at) FROM (
  SELECT MIN(r.created_at) AS created_at FROM spore_injections r WHERE ${sameSession('r', a)}
  UNION ALL SELECT MIN(r.created_at) FROM session_injections r WHERE ${sameSession('r', a)}))`;
const lineageValues = ['started_at', 'first_served_at'];
const lineageUpsert = (select: string, incremental: boolean) => {
  const values = incremental
    ? ['MIN(kpi_lineage.started_at,excluded.started_at)', 'COALESCE(MIN(kpi_lineage.first_served_at,excluded.first_served_at),kpi_lineage.first_served_at,excluded.first_served_at)']
    : lineageValues.map(c => `excluded.${c}`);
  return `INSERT INTO kpi_lineage(lineage_root,started_at,first_served_at) ${select}
    ON CONFLICT(lineage_root) DO UPDATE SET (${lineageValues.join(',')})=(${values.join(',')})
    WHERE (kpi_lineage.started_at,kpi_lineage.first_served_at) IS NOT (${values.join(',')})`;
};
export function reconcileLineages(roots: string): string[] {
  const from = `(${roots}) roots JOIN member_credentials c INDEXED BY idx_member_credentials_lineage ON c.lineage_root=roots.lineage_root
    JOIN sessions sess INDEXED BY idx_sessions_credential ON sess.created_by_token_id=c.id`;
  return [
    `DELETE FROM kpi_lineage WHERE lineage_root IN (${roots}) AND NOT EXISTS (SELECT 1 FROM member_credentials c INDEXED BY idx_member_credentials_lineage JOIN sessions s INDEXED BY idx_sessions_credential ON s.created_by_token_id=c.id WHERE c.lineage_root=kpi_lineage.lineage_root)`,
    lineageUpsert(`SELECT c.lineage_root,MIN(c.lineage_started_at),MIN(${earliestReceipt('sess')}) FROM ${from} WHERE true GROUP BY c.lineage_root`, false),
  ];
}

const rootsFor = (row: string) => `SELECT c.lineage_root FROM sessions s JOIN member_credentials c ON c.id=s.created_by_token_id WHERE ${sameSession('s', row)}`;
const incrementLineage = (row: string, receipt: boolean) => lineageUpsert(
  `SELECT c.lineage_root,c.lineage_started_at,${receipt ? `${row}.created_at` : earliestReceipt(row)} FROM member_credentials c
   ${receipt ? `JOIN sessions s ON s.created_by_token_id=c.id WHERE ${sameSession('s', row)}` : `WHERE c.id=${row}.created_by_token_id`}`, true);

export interface KpiTrigger { name: string; table: string; sql: string }
export function kpiTriggers(): KpiTrigger[] {
  const triggers: KpiTrigger[] = [];
  const add = (table: string, event: string, body: string[], when?: string) => {
    const name = `kpi_${table}_${event.split(' ')[0]!.toLowerCase()}`;
    triggers.push({ name, table, sql: `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table}${when ? ` WHEN ${when}` : ''} BEGIN\n${body.join(';\n')};\nEND` });
  };
  const roll = (row: string, sign: number) => `INSERT INTO kpi_daily(day,harness,${KPI_MEASURES.join(',')}) VALUES (${row}.day,${row}.harness,${KPI_MEASURES.map(c => `${sign}*${row}.${c}`).join(',')})
    ON CONFLICT(day,harness) DO UPDATE SET ${KPI_MEASURES.map(c => `${c}=kpi_daily.${c}+excluded.${c}`).join(',')}`;
  add('kpi_fact', 'INSERT', [roll('NEW', 1)]);
  add('kpi_fact', 'DELETE', [roll('OLD', -1)]);
  add('kpi_fact', 'UPDATE', [roll('OLD', -1), roll('NEW', 1)]);
  const rowKey = (row: string, key: string) => `SELECT ${row}.project_id AS project_id,${row}.session_id AS session_id,${key} AS k`;
  const session = (row: string) => rowKey(row, "''");
  const rowReconcile = (g: KpiGrain, row: string, key: string) => reconcileKpi(g, rowKey(row, key));
  const forSession = (g: KpiGrain, row: string) => reconcileKpi(g, sessionKeys(g, session(row)));
  const receiptLineage = (row: string, full: boolean) => full ? reconcileLineages(`${rootsFor(row)} AND ${row}.created_at <= (SELECT first_served_at FROM kpi_lineage WHERE lineage_root=c.lineage_root)`) : [incrementLineage(row, true)];
  const definitions: { table: string; update?: string; insert?: (row: string) => string[]; body: (row: string) => string[] }[] = [
    { table: 'session_prompts', update: 'generation,prompt_id,created_at,claim,prompt_kind', body: row => [
      ...rowReconcile('p', row, `${row}.prompt_id`),
      ...reconcileKpi('d', `SELECT r.project_id,r.session_id,r.id AS k FROM spore_injections r INDEXED BY idx_spore_injections_delivered WHERE ${sameSession('r', row)} AND r.delivered_prompt_id=${row}.prompt_id`),
    ] },
    { table: 'session_documents', update: 'state,generation',
      insert: row => (['p', 'c', 'd'] as const).map(g => upsertKpi(g, eligibleKpi(g,
        `(${session(row)}) q JOIN ${sources[g].table} x ON ${sameSession('x', 'q')}`, sources[g].key))),
      body: row => (['p', 'c', 'd'] as const).flatMap(g => forSession(g, row)) },
    { table: 'myco_tool_calls', update: 'generation,myco_tool,myco_op,created_at', body: row => rowReconcile('c', row, `${row}.tool_call_id`) },
    { table: 'spore_injections', update: 'delivered_at,delivered_prompt_id,spore_ids,created_at', body: row => [
      ...rowReconcile('d', row, `${row}.id`), ...rowReconcile('p', row, `${row}.delivered_prompt_id`),
    ] },
    { table: 'session_injections', update: 'kind,delivered_at,delivered_prompt_id,created_at', body: row => [
      ...rowReconcile('s', row, "''"), ...reconcileKpi('p', `${rowKey(row, `${row}.delivered_prompt_id`)} WHERE ${row}.kind='plan-nudge'`),
    ] },
    { table: 'prompt_identity_conflicts', body: row => rowReconcile('i', row, conflictKey(row)) },
    { table: 'prompt_context_answers', update: 'skipped,created_at', body: row => rowReconcile('a', row, `${row}.id`) },
    { table: 'transcripts', body: row => [
      ...rowReconcile('t', row, `${row}.transcript_id`), ...rowReconcile('m', row, `${row}.agent`),
      `UPDATE kpi_fact SET harness=h.harness FROM (SELECT ${harnessOf(row)} AS harness) h
       WHERE ${sameSession('kpi_fact', row)} AND grain IN ('p','c','s','d','i','a') AND ${row}.role='primary' AND kpi_fact.harness IS NOT h.harness`,
    ] },
  ];
  for (const def of definitions) {
    const receipt = def.table === 'spore_injections' || def.table === 'session_injections';
    add(def.table, 'INSERT', [...(def.insert ?? def.body)('NEW'), ...(receipt ? receiptLineage('NEW', false) : [])]);
    add(def.table, 'DELETE', [...def.body('OLD'), ...(receipt ? receiptLineage('OLD', true) : [])]);
    if (def.update) add(def.table, `UPDATE OF ${def.update}`, [
      ...def.body('OLD'), ...def.body('NEW'),
      ...(receipt ? [...reconcileLineages(`${rootsFor('OLD')} AND OLD.created_at<NEW.created_at AND OLD.created_at <= (SELECT first_served_at FROM kpi_lineage WHERE lineage_root=c.lineage_root)`), ...receiptLineage('NEW', false)] : []),
    ]);
  }
  add('sessions', 'INSERT', [...rowReconcile('s', 'NEW', "''"), incrementLineage('NEW', false)]);
  add('sessions', 'UPDATE OF first_received_at,created_by_token_id', [
    ...rowReconcile('s', 'NEW', "''"),
    ...reconcileLineages(`SELECT c.lineage_root FROM member_credentials c WHERE c.id=OLD.created_by_token_id AND OLD.created_by_token_id IS NOT NEW.created_by_token_id`),
    incrementLineage('NEW', false),
  ]);
  add('member_credentials', 'DELETE', reconcileLineages('SELECT OLD.lineage_root AS lineage_root'));
  return triggers;
}

export const KPI_JSON_KEYS = jsonKeys(['project_id', 'session_id', 'k']);
export const KPI_RECONCILE = Object.fromEntries((Object.keys(sources) as KpiGrain[]).map(grain => [grain,
  reconcileKpi(grain, KPI_JSON_KEYS).map((sql, i) => write<[string]>({ name: `kpi.${grain}Reconcile${i}`, sql })),
])) as Record<KpiGrain, ReturnType<typeof write<[string]>>[]>;
export const KPI_DOCUMENT_RECONCILE = (['p', 'c'] as const).flatMap(grain => reconcileKpi(grain, sessionKeys(grain, KPI_JSON_KEYS))
  .map((sql, i) => write<[string]>({ name: `kpi.${grain}SessionReconcile${i}`, sql })));
export const KPI_LINEAGE_RECONCILE = reconcileLineages(jsonKeys(['lineage_root']))
  .map((sql, i) => write<[string]>({ name: `kpi.lineageReconcile${i}`, sql }));
