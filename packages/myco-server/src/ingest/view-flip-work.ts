import type { PreparedStatement, RelationalStore, RunResult } from '../core/adapters.js';
import { contentAssertion } from '../core/registered-content.js';
import { CONTENT_STATEMENT_LIMIT, CONTENT_WALL_MS, type ContentUsage } from '../core/content-budget.js';
import { VIEW_MATERIALS, MATERIAL_COLUMNS } from '../db/view-tables.js';
import { MATERIAL_BODIES } from '../core/material-content.js';
import { PARSER_VERSION } from './parse.js';
import type { ViewWriteTarget } from './view-guard.js';
import { TURN_KIND } from '@goondocks/myco-shared/member-protocol';

const MATERIAL_ORIGINS = ['candidate', 'parent', 'previous', 'fact'] as const;
const PLACEMENT_TABLES = [
  'attachments',
  'spore_injections',
  'prompt_context_answers',
  'session_injections',
  'events',
] as const;
const balancedSum = (values: readonly string[]): string =>
  values.length === 1
    ? values[0]!
    : values.length === 0
      ? '0'
      : `(${balancedSum(values.slice(0, Math.floor(values.length / 2)))}+${balancedSum(values.slice(Math.floor(values.length / 2)))})`;
export const FLIP_WORK_FIELDS = [
  ...MATERIAL_ORIGINS.flatMap((origin) =>
    VIEW_MATERIALS.flatMap((material) =>
      ['rows', 'inline_bytes', 'blob_references'].map((metric) => `${origin}_${material.kind}_${metric}`),
    ),
  ),
  ...PLACEMENT_TABLES.map((table) => 'placement_' + table),
  'bindings',
  'acks',
  'ack_tail',
  'checkpoints',
  'checkpoint_chunks',
  'checkpoint_bytes',
  'mirror_chunks',
  'proofs',
  'fts_writes',
  'work_samples',
] as const;
export type FlipWorkload = Record<string, number>;
export interface FlipMeasurement {
  store: 'native' | 'remote';
  profile: 'serial' | 'parallel';
  source: string;
  sourceDigest: string;
  observedAt: number;
  parserVersion: number;
  workload: FlipWorkload;
  wallMs: number;
  statements: number;
  roundTrips: number;
  rowsRead: number | null;
  rowsWritten: number | null;
  cpuMs: number | null;
}
export interface FlipEnvelope {
  store: 'native' | 'remote';
  profile: 'serial' | 'parallel';
  measurement: FlipMeasurement | null;
  reserveFraction: number;
}

/** All workload dimensions require a dated, store-specific whole-transaction measurement. */
export function flipMeasurementAvailable(envelope: FlipEnvelope): boolean {
  const m = envelope.measurement;
  return (
    m !== null &&
    m.store === envelope.store &&
    m.profile === envelope.profile &&
    m.source.trim().length > 0 &&
    /^[a-f0-9]{64}$/.test(m.sourceDigest) &&
    Number.isSafeInteger(m.observedAt) &&
    m.observedAt > 0 &&
    m.parserVersion === PARSER_VERSION &&
    m.wallMs > 0 &&
    m.wallMs <= CONTENT_WALL_MS &&
    Number.isSafeInteger(m.statements) &&
    m.statements > 0 &&
    m.statements <= CONTENT_STATEMENT_LIMIT &&
    m.roundTrips > 0 &&
    Number.isFinite(envelope.reserveFraction) &&
    envelope.reserveFraction >= 0 &&
    Object.keys(m.workload).length === FLIP_WORK_FIELDS.length &&
    FLIP_WORK_FIELDS.every((field) => Number.isSafeInteger(m.workload[field]) && m.workload[field]! >= 0) &&
    [m.wallMs, m.roundTrips, m.cpuMs, m.rowsRead, m.rowsWritten].every(
      (value) => value === null || (Number.isFinite(value) && value >= 0),
    )
  );
}

export function flipWorkFits(work: FlipWorkload, envelope: FlipEnvelope, reserve = true): boolean {
  if (!flipMeasurementAvailable(envelope)) return false;
  return FLIP_WORK_FIELDS.every(
    (field) =>
      Number.isSafeInteger(work[field]) &&
      work[field]! >= 0 &&
      work[field]! * (reserve ? 1 + envelope.reserveFraction : 1) <= envelope.measurement!.workload[field]!,
  );
}

/** Counts include material stamps, both closures, facts, placements, bodies, mirrors and acknowledgement scans. */
export function flipWorkSql(target: ViewWriteTarget): { sql: string; params: unknown[] } {
  const project = `(SELECT json_extract(doc,'$.project') FROM input)`,
    session = `(SELECT json_extract(doc,'$.session') FROM input)`;
  const instance = (origin: (typeof MATERIAL_ORIGINS)[number]) =>
    origin === 'candidate'
      ? `(SELECT json_extract(doc,'$.instance') FROM input)`
      : origin === 'previous'
        ? `(SELECT json_extract(doc,'$.previous') FROM input)`
        : `(SELECT parent_instance FROM view_instances WHERE project_id=${project} AND instance_id=(SELECT json_extract(doc,'$.instance') FROM input))`;
  const entries: { key: string; sql: string }[] = [];
  for (const origin of MATERIAL_ORIGINS)
    for (const material of VIEW_MATERIALS) {
      const table = origin === 'fact' ? material.fact : material.table;
      const where = `project_id=${project} AND ${origin === 'fact' ? `session_id=${session}` : `instance_id=${instance(origin)}`}`;
      const columns = [
        ...MATERIAL_COLUMNS[material.kind].filter(
          (field) =>
            origin !== 'fact' ||
            !['call_source', 'outcome_source', 'tags_json', 'source_tag', 'source_coordinate'].includes(field),
        ),
        'project_id',
        'session_id',
        ...(origin === 'fact'
          ? ['event_id', 'token_id']
          : [
              'instance_id',
              'canonical_identity',
              'view_content_hash',
              'hash_scheme',
              'source_transcript_id',
              'source_offset',
              'source_end',
            ]),
      ];
      entries.push(
        { key: `${origin}_${material.kind}_rows`, sql: `(SELECT COUNT(*) FROM ${table} WHERE ${where})` },
        {
          key: `${origin}_${material.kind}_inline_bytes`,
          sql: `(SELECT COALESCE(SUM(${balancedSum(columns.map((field) => `COALESCE(length(CAST(${field} AS BLOB)),0)`))}),0) FROM ${table} WHERE ${where})`,
        },
        {
          key: `${origin}_${material.kind}_blob_references`,
          sql: `(SELECT COALESCE(SUM(${material.blobs.map((field) => `CASE WHEN ${field} IS NULL THEN 0 ELSE 1 END`).join('+')}),0) FROM ${table} WHERE ${where})`,
        },
      );
    }
  for (const table of PLACEMENT_TABLES)
    entries.push({
      key: 'placement_' + table,
      sql: `(SELECT COUNT(*) FROM ${table} WHERE project_id=${project} AND session_id=${session}
    ${table === 'events' ? `AND kind IN ('${TURN_KIND}','subagent.start','subagent.stop')` : ''})`,
    });
  const closure = `SELECT instance_id FROM view_instances WHERE project_id=${project} AND instance_id=${instance('candidate')}
    UNION ALL SELECT parent_instance FROM view_instances WHERE project_id=${project} AND instance_id=${instance('candidate')} AND parent_instance IS NOT NULL`;
  entries.push(
    {
      key: 'bindings',
      sql: `(SELECT COUNT(*) FROM material_versions WHERE project_id=${project} AND session_id=${session})`,
    },
    {
      key: 'acks',
      sql: `(SELECT COUNT(*) FROM extraction_acks WHERE project_id=${project} AND session_id=${session})`,
    },
    {
      key: 'ack_tail',
      sql: `(SELECT COUNT(*) FROM(SELECT f.ack_seq FROM view_legacy_ack_feed f JOIN view_build_work w ON w.project_id=f.project_id AND w.session_id=f.session_id
      WHERE f.project_id=${project} AND f.session_id=${session} AND f.ack_seq>w.legacy_ack_watermark ORDER BY f.ack_seq LIMIT 65))`,
    },
    {
      key: 'checkpoints',
      sql: `(SELECT COUNT(*) FROM view_checkpoints WHERE project_id=${project} AND instance_id=${instance('candidate')})`,
    },
    {
      key: 'checkpoint_chunks',
      sql: `(SELECT COUNT(*) FROM view_checkpoint_chunks WHERE project_id=${project} AND instance_id=${instance('candidate')})`,
    },
    {
      key: 'checkpoint_bytes',
      sql: `(SELECT COALESCE(SUM(length(CAST(parser_context AS BLOB))),0) FROM view_checkpoints WHERE project_id=${project} AND instance_id=${instance('candidate')})
      +(SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM view_checkpoint_chunks WHERE project_id=${project} AND instance_id=${instance('candidate')})`,
    },
    {
      key: 'mirror_chunks',
      sql: `(SELECT COUNT(*) FROM transcript_parser_state_chunks c JOIN transcripts t ON t.project_id=c.project_id AND t.transcript_id=c.transcript_id
      WHERE t.project_id=${project} AND t.session_id=${session})`,
    },
    {
      key: 'proofs',
      sql: `(SELECT COUNT(*) FROM view_content_proofs WHERE project_id=${project} AND instance_id IN(${closure}))`,
    },
    { key: 'fts_writes', sql: '0' },
    {
      key: 'work_samples',
      sql: `(SELECT COUNT(*) FROM view_work_samples WHERE project_id=${project} AND session_id=${session})`,
    },
  );
  if (entries.length !== FLIP_WORK_FIELDS.length) throw new Error('view_flip_work_definition_invalid');
  return {
    sql: `WITH input AS(SELECT ? doc) SELECT json_object(${entries.map((entry) => `'${entry.key}',${entry.sql}`).join(',')})`,
    params: [
      JSON.stringify({
        project: target.projectId,
        session: target.sessionId,
        instance: target.instanceId,
        previous: target.liveInstance,
      }),
    ],
  };
}

export async function readFlipWork(db: RelationalStore, target: ViewWriteTarget): Promise<FlipWorkload> {
  const source = flipWorkSql(target);
  const row = await db
    .prepare(`SELECT (${source.sql}) work`)
    .bind(...source.params)
    .first<{ work: string }>();
  if (!row) throw new Error('view_flip_work_absent');
  return JSON.parse(row.work) as FlipWorkload;
}

/** The batch admits current counts against the calibrated limits after its growth reserve. */
export function flipWorkGuard(
  db: RelationalStore,
  target: ViewWriteTarget,
  envelope: FlipEnvelope,
): PreparedStatement[] {
  const source = flipWorkSql(target);
  return contentAssertion(
    db,
    `NOT EXISTS(SELECT 1 FROM json_each((${source.sql})) j WHERE j.value>json_extract(?,'$.'||j.key))`,
    [...source.params, JSON.stringify(envelope.measurement!.workload)],
  );
}

/** How long an unfinished or overrun observation holds its calibration before the next flip may observe again. */
export const FLIP_OBSERVATION_LEASE_MS = 2 * 60_000;

/** A calibration is held while an observation begun within the lease is unfinished or overran its wall. */
export async function flipCalibrationBlocked(db: RelationalStore, envelope: FlipEnvelope, now: number): Promise<boolean> {
  const m = envelope.measurement!;
  const row = await db
    .prepare(
      `SELECT 1 held FROM view_flip_calibrations WHERE store=? AND profile=? AND source_digest=? AND blocked=1 AND observed_at>?`,
    )
    .bind(m.store, m.profile, m.sourceDigest, now - FLIP_OBSERVATION_LEASE_MS)
    .first<{ held: number }>();
  return row !== null;
}

/**
 * One observation at a time holds the calibration from `now`. A hold older than the lease is released, and a changed
 * measurement starts its record afresh, before the next flip claims it.
 */
export function beginFlipObservation(
  db: RelationalStore,
  envelope: FlipEnvelope,
  attempt: string,
  now: number,
): PreparedStatement[] {
  const m = envelope.measurement!;
  return [
    db
      .prepare(
        `UPDATE view_flip_calibrations SET blocked=0,measurement=?,source=?,
      maximum_wall_ms=CASE WHEN measurement IS ? THEN maximum_wall_ms ELSE 0 END,
      last_observation=CASE WHEN measurement IS ? THEN last_observation END
      WHERE store=? AND profile=? AND source_digest=? AND (blocked=0 OR observed_at<=?)`,
      )
      .bind(JSON.stringify(m), m.source, JSON.stringify(m), JSON.stringify(m), m.store, m.profile, m.sourceDigest, now - FLIP_OBSERVATION_LEASE_MS),
    ...contentAssertion(
      db,
      `NOT EXISTS(SELECT 1 FROM view_flip_calibrations WHERE store=? AND profile=? AND source_digest=? AND (blocked=1 OR measurement IS NOT ?))`,
      [m.store, m.profile, m.sourceDigest, JSON.stringify(m)],
    ),
    db
      .prepare(
        `INSERT INTO view_flip_calibrations(store,profile,source_digest,source,observed_at,attempt_id,measurement,blocked,maximum_wall_ms)
      VALUES(?,?,?,?,?,?,?,1,0) ON CONFLICT(store,profile,source_digest) DO UPDATE SET attempt_id=excluded.attempt_id,blocked=1,observed_at=excluded.observed_at`,
      )
      .bind(m.store, m.profile, m.sourceDigest, m.source, now, attempt, JSON.stringify(m)),
  ];
}

export async function finishFlipObservation(
  db: RelationalStore,
  envelope: FlipEnvelope,
  attempt: string,
  wallMs: number,
  work: FlipWorkload,
  usage: ContentUsage,
  results: readonly RunResult[],
) {
  const m = envelope.measurement!;
  const metric = (key: string) => {
    const values = results.map((result) => Reflect.get(result.meta, key));
    return values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  };
  const observation = {
    wallMs,
    statements: usage.statements + 1,
    roundTrips: usage.roundTrips + 1,
    transactionRowsRead: metric('rows_read'),
    transactionRowsWritten: metric('rows_written'),
    cpuMs: null,
    ftsWrites: 0,
    workload: work,
  };
  const changed = await db.batch([
    db
      .prepare(
        `UPDATE view_flip_calibrations SET blocked=?,maximum_wall_ms=MAX(maximum_wall_ms,?),last_observation=?
    WHERE store=? AND profile=? AND source_digest=? AND attempt_id=?`,
      )
      .bind(
        wallMs > CONTENT_WALL_MS ? 1 : 0,
        wallMs,
        JSON.stringify(observation),
        m.store,
        m.profile,
        m.sourceDigest,
        attempt,
      ),
  ]);
  if (changed[0]?.meta.changes !== 1) throw new Error('view_flip_observation_conflict');
  return observation;
}

/** Every blob-backed candidate or parent field retains exact durable instance-owned evidence. */
export function flipContentGuard(db: RelationalStore, target: ViewWriteTarget): PreparedStatement[] {
  const queries = VIEW_MATERIALS.flatMap((material) =>
    MATERIAL_BODIES[material.kind].map(([field, blob, kind]) => ({ material, field, blob, kind })),
  );
  return queries.flatMap(({ material, blob, kind }) =>
    contentAssertion(
      db,
      `NOT EXISTS(SELECT 1 FROM ${material.table} r
    WHERE r.project_id=? AND r.instance_id IN(SELECT instance_id FROM view_instances WHERE project_id=? AND instance_id=?
      UNION ALL SELECT parent_instance FROM view_instances WHERE project_id=? AND instance_id=? AND parent_instance IS NOT NULL)
      AND r.${blob} IS NOT NULL AND NOT EXISTS(SELECT 1 FROM view_content_proofs v JOIN blobs b ON b.project_id=v.project_id AND b.key=v.blob_key AND b.size=v.size
        JOIN registered_content_proofs p ON p.project_id=b.project_id AND p.key=b.key AND p.generation IS b.generation AND p.size=b.size
        WHERE v.project_id=r.project_id AND v.instance_id=r.instance_id AND v.kind=? AND v.record_id=r.${material.id} AND v.blob_key=r.${blob}
          AND v.digest=v.blob_key AND p.digest=p.key AND p.source_kind='view' AND p.source_id=r.instance_id AND p.event_id=r.instance_id AND p.envelope_hash=r.instance_id AND p.durable=1))`,
      [target.projectId, target.projectId, target.instanceId, target.projectId, target.instanceId, kind],
    ),
  );
}
