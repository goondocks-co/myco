import type { ServerEnv } from '../core/adapters.js';
import { contentAssertion, prepareDerivedContent, readVerifiedContentText, type DerivedContentSource } from '../core/registered-content.js';
import { readBundleEntry } from '../core/archive-bundle.js';
import { blobObjectKey } from '../core/blob-objects.js';
import { MATERIAL_BODIES, viewContentHash, VIEW_COLUMNS } from '../core/material-content.js';
import { VIEW_MATERIALS } from '../db/view-tables.js';
import { utf8Preview } from '../hash.js';
import { PARSER_VERSION, segmentSource, segmentBytes, type SegmentRow } from './parse.js';
import { manifestStatements } from './view-lifecycle.js';
import { VIEW_RECENT_MS } from './view-build-queue.js';
import { startViewSample } from './view-work-samples.js';
import { viewRowStatements, VIEW_INLINE_BODY_BYTES, VIEW_TOOL_OUTPUT_INLINE_BYTES, type ViewRow } from './view-writer.js';

export const FROZEN_COPY_PAGE_ROWS = 32;
export const FROZEN_IDENTITY_SCHEME = 'frozen-v1';
const LOST_CONTEXT = '{"mycoParserViewCheckpoint":1,"mycoParserMeta":null,"mycoParserState":{}}';

/** The first valid line boundary at or after the legacy frontier, among the bytes still held. */
async function tailStart(
  env: Pick<ServerEnv, 'db' | 'blobs'>,
  project: string,
  transcript: { transcript_id: string; size: number; parsed_offset: number },
): Promise<number> {
  const frontier = Math.min(transcript.parsed_offset, transcript.size);
  if (frontier >= transcript.size) return transcript.size;
  const segments = (
    await env.db
      .prepare(`SELECT * FROM (${segmentSource('?', '?', '?')}) ORDER BY base_offset LIMIT 8`)
      .bind(project, transcript.transcript_id, frontier, project, transcript.transcript_id, frontier)
      .all<SegmentRow>()
  ).results;
  if (segments.some((s) => s.base_offset <= frontier && frontier < s.base_offset + s.length)) return frontier;
  for (const segment of segments) {
    const bytes = await segmentBytes(env, segment.object_key, 0);
    const newline = bytes?.indexOf(0x0a) ?? -1;
    if (newline >= 0) return Math.min(transcript.size, segment.base_offset + newline + 1);
  }
  return transcript.size;
}

/** A session that lost bytes keeps its legacy derivation as a frozen parent and builds a tail from the held bytes. */
export async function startFrozenTail(
  env: Pick<ServerEnv, 'db' | 'blobs'>,
  project: string,
  session: string,
  now: number,
): Promise<{ frozen: string; tail: string }> {
  const db = env.db;
  const transcripts = (
    await db
      .prepare(`SELECT transcript_id,size,parsed_offset,parser_version FROM transcripts WHERE project_id=? AND session_id=?`)
      .bind(project, session)
      .all<{ transcript_id: string; size: number; parsed_offset: number; parser_version: number | null }>()
  ).results;
  const starts = await Promise.all(transcripts.map(async (t) => ({ id: t.transcript_id, start: await tailStart(env, project, t) })));
  const stamp = Math.max(0, ...transcripts.map((t) => t.parser_version ?? 0));
  const frozen = crypto.randomUUID(),
    tail = crypto.randomUUID();
  await db.batch([
    ...contentAssertion(
      db,
      `EXISTS(SELECT 1 FROM sessions WHERE project_id=? AND session_id=?)
    AND NOT EXISTS(SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?)
    AND NOT EXISTS(SELECT 1 FROM session_views WHERE project_id=? AND session_id=?)`,
      [project, session, project, session, project, session],
    ),
    db
      .prepare(
        `INSERT INTO view_instances(project_id,instance_id,session_id,parser_version,base,state,created_at) VALUES(?,?,?,?,'frozen','building',?)`,
      )
      .bind(project, frozen, session, stamp, now),
    db
      .prepare(
        `INSERT INTO view_instances(project_id,instance_id,session_id,parser_version,base,parent_instance,state,created_at)
      VALUES(?,?,?,?,'tail',?,'building',?)`,
      )
      .bind(project, tail, session, PARSER_VERSION, frozen, now),
    db
      .prepare(
        `INSERT INTO session_views(project_id,session_id,live_instance,building_instance,fence,legacy,updated_at,rebuild_state)
      VALUES(?,?,NULL,?,0,'converting',?,'building')`,
      )
      .bind(project, session, tail, now),
    db
      .prepare(
        `INSERT INTO view_build_work(project_id,session_id,instance_id,tier,recent_until,session_created_at,started_at)
      SELECT ?,?,?,CASE WHEN COALESCE(MAX(t.last_received_at),0)>? THEN 0 ELSE 1 END,
      COALESCE(MAX(t.last_received_at),0)+?,s.started_at,? FROM sessions s LEFT JOIN transcripts t
      ON t.project_id=s.project_id AND t.session_id=s.session_id WHERE s.project_id=? AND s.session_id=? GROUP BY s.started_at`,
      )
      .bind(project, session, tail, now - VIEW_RECENT_MS, VIEW_RECENT_MS, now, project, session),
    ...manifestStatements(db, project, session, tail),
    db
      .prepare(
        `UPDATE view_checkpoints SET start_offset=json_extract(j.value,'$.start'),parsed_offset=json_extract(j.value,'$.start'),
      parser_context=CASE WHEN json_extract(j.value,'$.start')>0 THEN ? END,lost_context=CASE WHEN json_extract(j.value,'$.start')>0 THEN 1 ELSE 0 END
      FROM json_each(?) j WHERE view_checkpoints.project_id=? AND view_checkpoints.instance_id=? AND view_checkpoints.transcript_id=json_extract(j.value,'$.id')`,
      )
      .bind(LOST_CONTEXT, JSON.stringify(starts), project, tail),
    ...startViewSample(db, project, session, tail),
  ]);
  return { frozen, tail };
}

const inlineLimit = (field: string) => (field === 'output_preview' ? VIEW_TOOL_OUTPUT_INLINE_BYTES : VIEW_INLINE_BODY_BYTES);

/** One page of a frozen copy: legacy rows with their complete bodies, each body above the inline limit as a verified blob. */
export async function copyFrozenPage(env: Pick<ServerEnv, 'db' | 'blobs'>, now: number): Promise<number> {
  const db = env.db;
  const instance = await db
    .prepare(
      `SELECT project_id,instance_id,session_id FROM view_instances INDEXED BY idx_view_active_leases
    WHERE state='building' AND base='frozen' ORDER BY lease_expires_at LIMIT 1`,
    )
    .first<{ project_id: string; instance_id: string; session_id: string }>();
  if (instance === null) return 0;
  const { project_id: project, instance_id: frozen, session_id: session } = instance;
  const token = await db
    .prepare(`SELECT token_id FROM transcripts WHERE project_id=? AND session_id=? ORDER BY rowid LIMIT 1`)
    .bind(project, session)
    .first<{ token_id: string }>();
  const source: DerivedContentSource = {
    projectId: project,
    sessionId: session,
    eventId: frozen,
    tokenId: token?.token_id ?? frozen,
    envelopeHash: frozen,
    sourceKind: 'view',
    resourceId: frozen,
  };
  const target = { projectId: project, sessionId: session, instanceId: frozen, liveInstance: null, fence: 0, leaseToken: null };
  for (const material of VIEW_MATERIALS) {
    const legacy = (
      await db
        .prepare(
          `SELECT r.*${material.kind === 'plan' ? `,(SELECT json_group_array(t.tag) FROM tags t WHERE t.project_id=r.project_id AND t.entity_kind='plan' AND t.entity_id=r.plan_key) tags_list` : ''}
      FROM ${material.fact} r JOIN fact_classes c ON c.project_id=r.project_id AND c.table_name='${material.fact}' AND c.record_id=r.${material.id} AND c.class='legacy'
      WHERE c.project_id=? AND c.session_id=? AND NOT EXISTS(SELECT 1 FROM ${material.table} v WHERE v.project_id=r.project_id AND v.instance_id=? AND v.${material.id}=r.${material.id})
      ORDER BY r.${material.id} LIMIT ?`,
        )
        .bind(project, session, frozen, FROZEN_COPY_PAGE_ROWS)
        .all<Record<string, unknown>>()
    ).results;
    if (legacy.length === 0) continue;
    const rows: ViewRow[] = [],
      proofs: { kind: string; id: string; key: string; digest: string; size: number }[] = [];
    for (const row of legacy) {
      const id = String(row[material.id]);
      const values: Record<string, unknown> = Object.fromEntries(VIEW_COLUMNS[material.kind].map((c) => [c, row[c] ?? null]));
      if (material.kind === 'tool' && row.input_bundle_id !== null && row.input_bundle_id !== undefined) {
        values.input = await readBundleEntry(env, {
          projectId: project,
          kind: 'tool-input',
          resourceId: id,
          bundleId: Number(row.input_bundle_id),
          entry: Number(row.input_bundle_entry),
          tokenId: String(row.token_id),
        });
        values.input_blob_key = null;
      }
      for (const [field, blob, proofKind] of MATERIAL_BODIES[material.kind]) {
        let full = typeof values[field] === 'string' ? (values[field] as string) : null;
        if (typeof row[blob] === 'string') {
          const held = await db
            .prepare(`SELECT generation,size FROM blobs WHERE project_id=? AND key=?`)
            .bind(project, row[blob])
            .first<{ generation: string | null; size: number }>();
          if (held === null) throw new Error('content_archive_missing');
          full = await readVerifiedContentText(env, blobObjectKey(project, String(row[blob]), held.generation), held.size, String(row[blob]));
        }
        values[blob] = null;
        if (full === null || new TextEncoder().encode(full).length <= inlineLimit(field)) {
          values[field] = full;
          continue;
        }
        const body = await prepareDerivedContent(env, source, full, now);
        proofs.push({ kind: proofKind, id, key: body.key, digest: body.digest, size: body.size });
        values[blob] = body.key;
        values[field] = utf8Preview(full, inlineLimit(field)).preview;
      }
      if (material.kind === 'plan') {
        const tags = JSON.parse(String(row.tags_list ?? '[]')) as string[];
        values.tags_json = JSON.stringify(tags);
        values.source_tag = typeof row.origin_path === 'string' ? row.origin_path.replace(/^transcript:/, '') : null;
        values.tags = tags;
      }
      const hash = await viewContentHash(material.kind, values);
      delete values.tags;
      rows.push({
        kind: material.kind,
        identity: JSON.stringify([FROZEN_IDENTITY_SCHEME, material.kind, id]),
        recordId: id,
        hash,
        values,
        expectedHash: null,
      });
    }
    await db.batch([
      ...contentAssertion(
        db,
        `EXISTS(SELECT 1 FROM view_instances WHERE project_id=? AND instance_id=? AND base='frozen' AND state='building')
      AND NOT EXISTS(SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?)`,
        [project, frozen, project, session],
      ),
      ...viewRowStatements(db, target, rows),
      db
        .prepare(
          `INSERT OR REPLACE INTO view_content_proofs(project_id,instance_id,session_id,kind,record_id,blob_key,digest,size,verified_at)
        SELECT ?,?,?,json_extract(value,'$.kind'),json_extract(value,'$.id'),json_extract(value,'$.key'),json_extract(value,'$.digest'),json_extract(value,'$.size'),?
        FROM json_each(?)`,
        )
        .bind(project, frozen, session, now, JSON.stringify(proofs)),
    ]);
    return rows.length;
  }
  await db
    .prepare(`UPDATE view_instances SET state='frozen' WHERE project_id=? AND instance_id=? AND base='frozen' AND state='building'`)
    .bind(project, frozen)
    .run();
  return 1;
}
