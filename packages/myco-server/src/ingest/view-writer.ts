import {
  VIEW_COLUMNS as columns,
  viewContentHash,
  MATERIAL_BODIES as bodyFields,
  materialBodyDigest,
  type ViewKind,
} from '../core/material-content.js';
import { filesNamedByToolInput } from '@goondocks/myco-shared/member-protocol';
import { MAX_BLOB_BYTES } from '../constants.js';
import { kindSpec, parsePayload, type KindSpec, type Bound } from './kinds.js';
import { boundDerivedEvent } from './parsers/bounds.js';
import type { PreparedStatement, RelationalStore, ServerEnv } from '../core/adapters.js';
import {
  contentAssertion,
  prepareDerivedContent,
  type VerifiedContent,
  type DerivedContentSource,
} from '../core/registered-content.js';
import { remainingContentBudget } from '../core/content-budget.js';
import {
  publicationVersionStatements,
  finishVersionStatements,
  VIEW_HASH_SCHEME,
  type MaterialVersion,
} from '../core/material-versions.js';
import { VIEW_MATERIALS, MATERIALS } from '../db/view-tables.js';
import { sha256Hex, utf8Preview } from '../hash.js';
import { type ViewWriteTarget, viewWriteGuard, viewWritePredicate } from './view-guard.js';
import { liveFrontierMirrorStatements, viewCheckpointStatements, type ViewCheckpoint } from './view-checkpoint.js';
import { viewLiveProjectionStatements } from './view-projections.js';
import { assembleToolOutcome, type OutcomeSource } from './tool-outcome.js';
import type { DerivedEvent, ParserState } from './parsers/index.js';
import { viewSampleProgress } from './view-work-samples.js';

export const VIEW_INLINE_BODY_BYTES = 16_384;
/** A tool output keeps the catalogue's preview inline; the complete output is a verified blob. */
export const VIEW_TOOL_OUTPUT_INLINE_BYTES = 4_096;
const inlineBodyBytes = (field: string): number =>
  field === 'output' || field === 'output_preview' ? VIEW_TOOL_OUTPUT_INLINE_BYTES : VIEW_INLINE_BODY_BYTES;
const kinds = VIEW_MATERIALS.map((material) => material.kind);
export type { ViewKind } from '../core/material-content.js';
export { viewContentHash } from '../core/material-content.js';
export interface ViewRow extends MaterialVersion {
  kind: ViewKind;
  values: Record<string, unknown>;
  expectedHash: string | null;
}
export const materialTable = (kind: ViewKind) => MATERIALS[kind];
const nullable = (value: unknown) => (value === undefined ? null : value);
const text = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value ?? {}));

/** The receipt-time read for source offsets a cache does not hold yet. */
function receiptRead(db: RelationalStore, project: string, transcript: string, missing: readonly number[]): PreparedStatement {
  return db
    .prepare(
      `SELECT j.value offset,COALESCE(
    (SELECT s.received_at FROM transcript_segments s WHERE s.project_id=? AND s.transcript_id=? AND s.base_offset<=j.value AND s.base_offset+s.length>j.value ORDER BY s.base_offset DESC LIMIT 1),
    (SELECT r.received_at FROM raw_archive_refs r WHERE r.project_id=? AND r.transcript_id=? AND r.source_kind='transcript' AND r.disposition='archived'
      AND r.base_offset<=j.value AND r.base_offset+r.length>j.value ORDER BY r.base_offset DESC LIMIT 1)) received_at FROM json_each(?) j`,
    )
    .bind(project, transcript, project, transcript, JSON.stringify(missing));
}

function heldReceipts(rows: readonly { offset: number; received_at: number | null }[], cache: Map<number, number>) {
  for (const row of rows) {
    if (row.received_at === null) throw new Error('view_source_receipt_absent');
    cache.set(row.offset, row.received_at);
  }
  return cache;
}

/** Original receipt times bound each source record independently of the rebuild clock. */
export async function viewSourceReceipts(
  db: RelationalStore,
  project: string,
  transcript: string,
  offsets: readonly number[],
  cache = new Map<number, number>(),
): Promise<Map<number, number>> {
  const missing = [...new Set(offsets)].filter((offset) => !cache.has(offset));
  if (!missing.length) return cache;
  const rows = (await receiptRead(db, project, transcript, missing).all<{ offset: number; received_at: number | null }>()).results;
  return heldReceipts(rows, cache);
}

const payloadBodies: Readonly<Record<string, readonly string[]>> = {
  prompt: ['text'],
  response: ['text'],
  plan: ['content'],
  'tool.use': ['input', 'output'],
  'tool.failure': ['input', 'output'],
};

/** View bodies use verified blob admission; all other fields retain catalogue bounds. */
export function admittedViewEvent(event: DerivedEvent, now: number): DerivedEvent {
  const spec = kindSpec(event.kind),
    bodies = payloadBodies[event.kind];
  if (!spec || !bodies) throw new Error('view_record_kind_unsupported');
  if (event.payload.blob !== undefined || event.payload.outputBlob !== undefined)
    throw new Error('view_record_refused: parser bodies require inline source content');
  const placeholder = { ...event.payload };
  for (const field of bodies)
    if (placeholder[field] !== undefined) placeholder[field] = typeof placeholder[field] === 'string' ? '' : {};
  const bounded = boundDerivedEvent({ ...event, payload: placeholder });
  const payload = { ...bounded.payload };
  for (const field of bodies) if (event.payload[field] !== undefined) payload[field] = event.payload[field];
  if (Object.values(payload).some((value) => typeof value === 'string' && /[\uD800-\uDFFF]/u.test(value)))
    throw new Error('view_record_refused: string contains an unpaired surrogate');
  const bound = (field: string, value: Bound): Bound =>
    !bodies.includes(field)
      ? value
      : value.type === 'string'
        ? { ...value, max: MAX_BLOB_BYTES }
        : value.type === 'json'
          ? { ...value, maxBytes: MAX_BLOB_BYTES }
          : value;
  const viewSpec: KindSpec = {
    ...spec,
    fields: Object.fromEntries(
      Object.entries(spec.fields).map(([field, value]) => [field, { ...value, bound: bound(field, value.bound) }]),
    ),
  };
  const admitted = parsePayload(viewSpec, payload, now);
  if (!admitted.ok) throw new Error('view_record_refused: ' + admitted.reason);
  return { ...event, payload: admitted.value };
}

export async function prepareViewRows(
  env: Pick<ServerEnv, 'db' | 'blobs'>,
  target: ViewWriteTarget,
  rawEvents: readonly DerivedEvent[],
  range: {
    transcriptId: string;
    end: number;
    ordinal: number;
    receivedAt: number;
    machineId: string;
    sessionMachineId: string | null;
    receipts?: Map<number, number>;
    lostContext?: boolean;
  },
  source: DerivedContentSource,
  now: number,
): Promise<{ rows: ViewRow[]; proofs: PreparedStatement[] }> {
  const events = rawEvents.map((event) => admittedViewEvent(event, now));
  const bodyCandidates = new Map<string, { key: string; size: number }>();
  for (const event of events)
    for (const field of payloadBodies[event.kind] ?? []) {
      const value = event.payload[field];
      if (value === undefined || value === null) continue;
      const body = typeof value === 'string' ? value : JSON.stringify(value),
        size = new TextEncoder().encode(body).length;
      if (size > inlineBodyBytes(field)) {
        const key = await sha256Hex(body);
        bodyCandidates.set(key, { key, size });
      }
    }
  const promptIds = [
    ...new Set(
      events.flatMap((event) =>
        event.kind === 'response' && typeof event.payload.promptId === 'string'
          ? [event.payload.promptId]
          : event.kind === 'prompt'
            ? [String(event.payload.promptId)]
            : [],
      ),
    ),
  ];
  const received = range.receipts ?? new Map<number, number>();
  const unreceived = [...new Set(events.map((event) => event.offset))].filter((offset) => !received.has(offset));
  const priorReads = kinds.flatMap((kind) => {
    const table = materialTable(kind);
    const ids = events
      .filter((event) =>
        kind === 'tool' ? event.kind === 'tool.use' || event.kind === 'tool.failure' : event.kind === kind,
      )
      .map((event) =>
        String(event.payload[kind === 'tool' ? 'toolCallId' : kind === 'plan' ? 'planKey' : kind + 'Id']),
      );
    if (kind === 'prompt')
      ids.push(
        ...events
          .filter((event) => event.kind === 'response' && typeof event.payload.promptId === 'string')
          .map((event) => String(event.payload.promptId)),
      );
    if (ids.length === 0) return [];
    return [
      {
        kind,
        read: env.db
          .prepare(
            `SELECT r.* FROM json_each(?) j CROSS JOIN ${table.table} r
      WHERE r.project_id=? AND r.instance_id=? AND r.${table.id}=j.value`,
          )
          .bind(JSON.stringify(ids), target.projectId, target.instanceId),
      },
    ];
  });
  // The window's independent reads travel together: one round trip, whatever the number of kinds.
  const reads = [
    ...(bodyCandidates.size
      ? [
          env.db
            .prepare(
              `SELECT p.key,p.generation,p.size,p.digest FROM json_each(?) j
    CROSS JOIN blobs b JOIN registered_content_proofs p ON p.project_id=b.project_id AND p.key=b.key AND p.generation IS b.generation
    WHERE b.project_id=? AND b.key=json_extract(j.value,'$.key') AND b.size=json_extract(j.value,'$.size')
      AND p.source_kind='view' AND p.source_id=? AND p.event_id=? AND p.envelope_hash=? AND p.digest=p.key AND p.size=b.size AND p.durable=1`,
            )
            .bind(
              JSON.stringify([...bodyCandidates.values()]),
              target.projectId,
              target.instanceId,
              target.instanceId,
              target.instanceId,
            ),
        ]
      : []),
    ...(unreceived.length ? [receiptRead(env.db, target.projectId, range.transcriptId, unreceived)] : []),
    ...priorReads.map((prior) => prior.read),
    ...(promptIds.length
      ? [
          env.db
            .prepare(
              `SELECT j.value prompt_id,MIN(r.created_at) ended_at FROM json_each(?) j LEFT JOIN view_responses r
      ON r.project_id=? AND r.instance_id=? AND r.prompt_id=j.value
        AND EXISTS(SELECT 1 FROM transcripts t JOIN sessions s ON s.project_id=t.project_id AND s.session_id=t.session_id
          WHERE t.project_id=r.project_id AND t.transcript_id=r.source_transcript_id AND t.machine_id IS s.machine_id) GROUP BY j.value`,
            )
            .bind(JSON.stringify(promptIds), target.projectId, target.instanceId),
        ]
      : []),
  ];
  const results = reads.length ? (await env.db.batch(reads)).map((result) => result.results) : [];
  let read = 0;
  const reusable = (bodyCandidates.size ? results[read++] : []) as VerifiedContent[];
  if (unreceived.length) heldReceipts(results[read++] as { offset: number; received_at: number | null }[], received);
  const priorRows = new Map<string, Record<string, unknown>>();
  for (const prior of priorReads)
    for (const row of results[read++] as Record<string, unknown>[])
      priorRows.set(prior.kind + ':' + String(row[materialTable(prior.kind).id]), row);
  const promptEnds = (promptIds.length ? results[read++] : []) as { prompt_id: string; ended_at: number | null }[];
  const preparedBodies = new Map(reusable.map((body) => [body.key, Promise.resolve(body)]));
  const bodyProofs: (VerifiedContent & { kind: string; id: string })[] = [];
  const fullRows = new Map<string, Record<string, unknown>>();
  const rows = new Map<string, ViewRow>(),
    proofs: PreparedStatement[] = [];
  const resources = [...priorRows].flatMap(([key, row]) => {
    const kind = key.slice(0, key.indexOf(':')) as ViewKind;
    return bodyFields[kind].flatMap(([field, blobField, proofKind]) =>
      typeof row[blobField] === 'string'
        ? [{ kind: proofKind, id: String(row[materialTable(kind).id]), key: row[blobField], field }]
        : [],
    );
  });
  const heldProofs = resources.length
    ? (
        await env.db
          .prepare(
            `SELECT p.kind,p.record_id,p.blob_key,p.digest,b.generation,b.size
    FROM json_each(?) j CROSS JOIN view_content_proofs p JOIN blobs b ON b.project_id=p.project_id AND b.key=p.blob_key AND b.size=p.size
    JOIN registered_content_proofs cp ON cp.project_id=p.project_id AND cp.key=p.blob_key AND cp.generation IS b.generation
      AND cp.source_kind='view' AND cp.source_id=p.instance_id AND cp.event_id=p.instance_id AND cp.envelope_hash=p.instance_id
      AND cp.digest=p.digest AND cp.size=p.size AND cp.durable=1
    WHERE p.project_id=? AND p.instance_id=? AND p.kind=json_extract(j.value,'$.kind') AND p.record_id=json_extract(j.value,'$.id')
      AND p.blob_key=json_extract(j.value,'$.key')`,
          )
          .bind(JSON.stringify(resources), target.projectId, target.instanceId)
          .all<{
            kind: string;
            record_id: string;
            blob_key: string;
            digest: string;
            generation: string | null;
            size: number;
          }>()
      ).results
    : [];
  const proofMap = new Map(heldProofs.map((row) => [JSON.stringify([row.kind, row.record_id, row.blob_key]), row]));
  if (heldProofs.length)
    proofs.push(
      ...contentAssertion(
        env.db,
        `NOT EXISTS(SELECT 1 FROM json_each(?) j
    LEFT JOIN view_content_proofs p ON p.project_id=? AND p.instance_id=? AND p.kind=json_extract(j.value,'$.kind')
      AND p.record_id=json_extract(j.value,'$.record_id') AND p.blob_key=json_extract(j.value,'$.blob_key')
    LEFT JOIN blobs b ON b.project_id=p.project_id AND b.key=p.blob_key
    LEFT JOIN registered_content_proofs cp ON cp.project_id=p.project_id AND cp.key=p.blob_key AND cp.generation IS b.generation
      AND cp.source_kind='view' AND cp.source_id=p.instance_id AND cp.event_id=p.instance_id AND cp.envelope_hash=p.instance_id
      AND cp.digest=p.digest AND cp.size=p.size AND cp.durable=1
    WHERE cp.key IS NULL OR p.digest IS NOT json_extract(j.value,'$.digest') OR b.size IS NOT json_extract(j.value,'$.size')
      OR b.generation IS NOT json_extract(j.value,'$.generation'))`,
        [JSON.stringify(heldProofs), target.projectId, target.instanceId],
      ),
    );
  const hydrate = async (
    kind: ViewKind,
    id: string,
    row: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const full: Record<string, unknown> = {
      ...row,
      ...(kind === 'plan' ? { tags: JSON.parse(String(row.tags_json)) } : {}),
    };
    for (const [field, blobField, proofKind] of bodyFields[kind]) {
      const blob = full[blobField];
      if (typeof blob !== 'string') continue;
      const proof = proofMap.get(JSON.stringify([proofKind, id, blob]));
      if (!proof) throw new Error('view_body_proof_absent');
      if (proof.digest !== blob) throw new Error('view_body_digest');
    }
    return full;
  };
  // A window's bodies are prepared side by side; each is complete before the window answers.
  const pendingProofs: Promise<VerifiedContent & { kind: string; id: string }>[] = [];
  try {
    for (const event of events) {
      const kind: ViewKind | undefined =
        event.kind === 'prompt'
          ? 'prompt'
          : event.kind === 'response'
            ? 'response'
            : event.kind === 'plan'
              ? 'plan'
              : event.kind === 'tool.use' || event.kind === 'tool.failure'
                ? 'tool'
                : undefined;
      if (kind === undefined) throw new Error('view_record_kind_unsupported');
      const p = event.payload,
        table = materialTable(kind),
        id = String(p[kind === 'tool' ? 'toolCallId' : kind === 'plan' ? 'planKey' : kind + 'Id']);
      if (id === 'undefined') throw new Error('view_record_identity_absent');
      const sourceKey =
        typeof p.sourceKey === 'string' ? p.sourceKey : event.source && 'key' in event.source ? event.source.key : null;
      if (event.identity === undefined) throw new Error('view_record_identity_absent');
      const identity = JSON.stringify([kind, id, ...event.identity]);
      const key = kind + ':' + id;
      const receipt = received.get(event.offset);
      if (receipt === null || receipt === undefined) throw new Error('view_source_receipt_absent');
      const stored = priorRows.get(key);
      const previous = rows.get(key);
      if (previous && previous.identity !== identity) throw new Error('identity_collision');
      if (stored?.canonical_identity && stored.canonical_identity !== identity) throw new Error('identity_collision');
      const old = previous ? { ...fullRows.get(key) } : stored ? await hydrate(kind, id, stored) : undefined;
      let values: Record<string, unknown> = {
        [table.id]: id,
        prompt_id: p.promptId ?? null,
        created_at: event.createdAt,
        updated_at: event.createdAt,
        received_at: receipt,
        source_transcript_id: range.transcriptId,
        source_offset: event.offset,
        source_end: event.sourceEnd ?? range.end,
        source_key: sourceKey,
        source_thread: p.sourceThread ?? (event.source && 'thread' in event.source ? event.source.thread : null) ?? null,
        source_record:
          p.sourceRecord ?? (kind !== 'prompt' && event.source && 'key' in event.source ? event.source.key : null),
      };
      if (kind === 'prompt')
        Object.assign(values, {
          text: p.text ?? null,
          blob_key: p.blob ?? null,
          parent_prompt_id: p.parentPromptId ?? null,
          thread_id: p.threadId ?? null,
          thread_label: p.threadLabel ?? null,
          origin: p.origin ?? 'user',
          prompt_kind: p.promptKind ?? null,
          prompt_key_hash: p.promptKeyHash ?? null,
          claim: p.claim ?? null,
        });
      if (kind === 'response') Object.assign(values, { text: p.text ?? null, blob_key: p.blob ?? null });
      if (kind === 'plan')
        Object.assign(values, {
          title: p.title ?? null,
          content: p.content ?? null,
          blob_key: p.blob ?? null,
          status: p.status ?? 'active',
          origin_path: p.originPath ?? null,
          source: p.source ?? 'tag',
          tags: p.tags ?? [],
          tags_json: JSON.stringify(p.tags ?? []),
          source_tag: p.tags instanceof Array ? (p.tags[0] ?? null) : null,
          source_coordinate: JSON.stringify(event.coordinate ?? []),
        });
      if (kind === 'tool') {
        const coordinate: OutcomeSource = {
          ordinal: range.ordinal,
          offset: event.outcomeOffset ?? event.offset,
          origin: event.outcomeOrigin ?? 'reported',
        };
        const incoming = {
          values: {
            ...values,
            tool_name: p.toolName ?? 'unknown',
            input: text(p.input),
            input_bytes: new TextEncoder().encode(text(p.input)).length,
            myco_tool: p.mycoTool ?? null,
            myco_op: p.mycoOp ?? null,
            files_affected: JSON.stringify(p.filesAffected ?? filesNamedByToolInput(p.input)),
            canopy_injection_tokens: p.canopyInjectionTokens ?? null,
            success: p.success === false || event.kind === 'tool.failure' ? 0 : 1,
            output_preview: p.output ?? null,
            error_message: p.errorMessage ?? null,
            result_reason: p.resultReason ?? null,
            duration_ms: p.durationMs ?? null,
          },
          call:
            typeof p.toolName === 'string' && p.toolName !== 'unknown'
              ? { ...coordinate, offset: event.callOffset ?? event.offset }
              : null,
          outcome: coordinate,
        };
        const prior = old
          ? {
              values: old,
              call: typeof old.call_source === 'string' ? (JSON.parse(old.call_source) as OutcomeSource) : null,
              outcome:
                typeof old.outcome_source === 'string' ? (JSON.parse(old.outcome_source) as OutcomeSource) : coordinate,
            }
          : null;
        const merged = assembleToolOutcome(prior, incoming);
        values = {
          ...values,
          ...merged.values,
          call_source: JSON.stringify(merged.call),
          outcome_source: JSON.stringify(merged.outcome),
        };
      }
      if (
        kind === 'tool' &&
        old &&
        typeof old.call_source === 'string' &&
        p.toolName !== 'unknown' &&
        ((await materialBodyDigest('tool', old, 'input')) !==
          (await materialBodyDigest('tool', { input: text(p.input) }, 'input')) ||
          old.tool_name !== p.toolName)
      ) {
        proofs.push(
          env.db
            .prepare(
              `INSERT OR IGNORE INTO view_findings(project_id,instance_id,session_id,kind,record_id,n)
          VALUES(?,?,?,'key_reuse',?,0)`,
            )
            .bind(target.projectId, target.instanceId, target.sessionId, id),
        );
      }
      const hash = await viewContentHash(kind, values);
      if (old && kind !== 'tool' && (previous?.hash ?? old.view_content_hash) !== hash) {
        proofs.push(
          env.db
            .prepare(
              `INSERT OR IGNORE INTO view_findings(project_id,instance_id,session_id,kind,record_id,n)
          VALUES(?,?,?,'key_reuse',?,0)`,
            )
            .bind(target.projectId, target.instanceId, target.sessionId, id),
        );
        continue;
      }
      if (old && kind !== 'tool') continue;
      if (range.lostContext && kind !== 'prompt' && values.prompt_id === null)
        proofs.push(
          env.db
            .prepare(
              `INSERT OR IGNORE INTO view_findings(project_id,instance_id,session_id,kind,record_id,n)
        VALUES(?,?,?,'unattributed',?,0)`,
            )
            .bind(target.projectId, target.instanceId, target.sessionId, id),
        );
      fullRows.set(key, { ...values });
      const bodyField = kind === 'plan' ? 'content' : kind === 'tool' ? 'input' : 'text';
      values.content_hash = await materialBodyDigest(kind, values, bodyField);
      for (const [field, blobField, proofKind] of bodyFields[kind]) {
        if (typeof values[blobField] === 'string') continue;
        const full = values[field!];
        if (typeof full !== 'string' || new TextEncoder().encode(full).length <= inlineBodyBytes(field!)) continue;
        const digest = await sha256Hex(full);
        let body = preparedBodies.get(digest);
        if (!body) {
          body = prepareDerivedContent(env, source, full, now, viewWritePredicate(target, now));
          preparedBodies.set(digest, body);
        }
        const row = values;
        const proof = body.then((held) => {
          row[blobField!] = held.key;
          return { ...held, kind: proofKind, id };
        });
        proof.catch(() => undefined);
        pendingProofs.push(proof);
        values[field!] = utf8Preview(full, inlineBodyBytes(field!)).preview;
      }
      rows.set(key, {
        kind,
        identity,
        recordId: id,
        hash,
        values,
        expectedHash:
          previous?.expectedHash ?? (typeof stored?.view_content_hash === 'string' ? stored.view_content_hash : null),
      });
    }
  } finally {
    await Promise.allSettled(pendingProofs);
  }
  bodyProofs.push(...(await Promise.all(pendingProofs)));
  if (bodyProofs.length) {
    const input = JSON.stringify(bodyProofs);
    proofs.push(
      ...contentAssertion(
        env.db,
        `NOT EXISTS(SELECT 1 FROM json_each(?) j
      LEFT JOIN blobs b ON b.project_id=? AND b.key=json_extract(j.value,'$.key')
      LEFT JOIN registered_content_proofs p ON p.project_id=b.project_id AND p.key=b.key AND p.generation IS b.generation
        AND p.source_kind='view' AND p.source_id=? AND p.event_id=? AND p.envelope_hash=? AND p.durable=1
      WHERE b.size IS NOT json_extract(j.value,'$.size') OR b.generation IS NOT json_extract(j.value,'$.generation')
        OR p.key IS NULL OR p.digest IS NOT json_extract(j.value,'$.digest') OR p.size IS NOT b.size)`,
        [input, target.projectId, target.instanceId, target.instanceId, target.instanceId],
      ),
      env.db
        .prepare(
          `INSERT OR REPLACE INTO view_content_proofs(project_id,instance_id,session_id,kind,record_id,blob_key,digest,size,verified_at)
        SELECT ?,?,?,json_extract(value,'$.kind'),json_extract(value,'$.id'),json_extract(value,'$.key'),json_extract(value,'$.digest'),json_extract(value,'$.size'),?
        FROM json_each(?)`,
        )
        .bind(target.projectId, target.instanceId, target.sessionId, now, input),
    );
  }
  if (promptIds.length) {
    const held = promptEnds;
    const earliest = new Map(held.map((row) => [row.prompt_id, row.ended_at]));
    for (const row of rows.values())
      if (
        row.kind === 'response' &&
        typeof row.values.prompt_id === 'string' &&
        range.machineId === range.sessionMachineId
      ) {
        const id = row.values.prompt_id,
          at = Number(row.values.created_at);
        earliest.set(id, Math.min(earliest.get(id) ?? at, at));
      }
    for (const id of promptIds) {
      const end = earliest.get(id);
      if (end === null || end === undefined) continue;
      const key = 'prompt:' + id,
        staged = rows.get(key),
        stored = priorRows.get(key);
      if (!staged && !stored) continue;
      const logical = staged ? { ...fullRows.get(key) } : await hydrate('prompt', id, stored!);
      if (logical.ended_at === end) continue;
      logical.ended_at = end;
      const values = { ...(staged?.values ?? stored!), ended_at: end };
      rows.set(key, {
        kind: 'prompt',
        recordId: id,
        identity: staged?.identity ?? String(stored!.canonical_identity),
        hash: await viewContentHash('prompt', logical),
        values,
        expectedHash: staged ? staged.expectedHash : String(stored!.view_content_hash),
      });
    }
  }
  return { rows: [...rows.values()], proofs };
}

export function viewRowStatements(
  db: RelationalStore,
  target: ViewWriteTarget,
  rows: readonly ViewRow[],
): PreparedStatement[] {
  return kinds.flatMap((kind) => {
    const held = rows.filter((row) => row.kind === kind);
    if (held.length === 0) return [];
    const table = materialTable(kind),
      fields = [
        ...columns[kind],
        'source_transcript_id',
        'source_offset',
        'source_end',
        'canonical_identity',
        'view_content_hash',
        'hash_scheme',
      ];
    const input = JSON.stringify(
      held.map((row) => ({
        ...row.values,
        canonical_identity: row.identity,
        view_content_hash: row.hash,
        hash_scheme: VIEW_HASH_SCHEME,
        expected_hash: row.expectedHash,
      })),
    );
    return [
      ...contentAssertion(
        db,
        `NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN ${table.table} r
      ON r.project_id=? AND r.instance_id=? AND r.${table.id}=json_extract(j.value,'$.${table.id}')
      WHERE r.view_content_hash IS NOT json_extract(j.value,'$.expected_hash'))`,
        [input, target.projectId, target.instanceId],
      ),
      db
        .prepare(
          `INSERT INTO ${table.table}(project_id,instance_id,session_id,${fields.join(',')})
        SELECT ?,?,?,${fields.map((field) => `json_extract(value,'$.${field}')`).join(',')} FROM json_each(?) WHERE 1
        ON CONFLICT(project_id,instance_id,${table.id}) DO UPDATE SET ${fields
          .filter((field) => field !== table.id)
          .map((field) => `${field}=excluded.${field}`)
          .join(',')}`,
        )
        .bind(target.projectId, target.instanceId, target.sessionId, input),
    ];
  });
}

export function stampVersionStatements(
  db: RelationalStore,
  target: ViewWriteTarget,
  attempt: string,
  rows?: readonly ViewRow[],
): PreparedStatement[] {
  return kinds
    .filter((kind) => rows === undefined || rows.some((row) => row.kind === kind))
    .map((kind) => {
      const table = materialTable(kind);
      return db
        .prepare(
          `UPDATE ${table.table} SET material_seq=(
    SELECT v.material_seq FROM view_publication_material v WHERE v.project_id=? AND v.session_id=? AND v.attempt_id=? AND v.kind=? AND v.identity=${table.table}.canonical_identity)
    WHERE project_id=? AND instance_id=? AND EXISTS(SELECT 1 FROM view_instances i WHERE i.project_id=${table.table}.project_id
      AND i.instance_id=${table.table}.instance_id AND i.base<>'frozen')${rows === undefined ? '' : ` AND ${table.id} IN(SELECT value FROM json_each(?))`}`,
        )
        .bind(
          target.projectId,
          target.sessionId,
          attempt,
          kind,
          target.projectId,
          target.instanceId,
          ...(rows === undefined
            ? []
            : [JSON.stringify(rows.filter((row) => row.kind === kind).map((row) => row.recordId))]),
        );
    });
}

export async function writeViewWindow(
  env: Pick<ServerEnv, 'db' | 'blobs'>,
  target: ViewWriteTarget,
  prepared: { rows: ViewRow[]; proofs: PreparedStatement[] },
  checkpoint: ViewCheckpoint,
  to: number,
  state: ParserState,
  metadata: Record<string, unknown> | undefined,
  now: number,
  fidelity: string,
): Promise<void> {
  const attempt = crypto.randomUUID();
  const live =
    target.leaseToken === null
      ? viewLiveProjectionStatements(env.db, target, prepared.rows)
      : { before: [], after: [] };
  const writes = [
    ...viewWriteGuard(env.db, target, now),
    ...contentAssertion(
      env.db,
      `EXISTS(SELECT 1 FROM view_checkpoints
    WHERE project_id=? AND instance_id=? AND transcript_id=? AND parsed_offset=? AND parsed_offset<=? AND parser_context IS ?)`,
      [target.projectId, target.instanceId, checkpoint.transcriptId, checkpoint.offset, to, checkpoint.context],
    ),
    ...prepared.proofs,
    ...live.before,
    ...viewRowStatements(env.db, target, prepared.rows),
    ...(target.leaseToken === null ? [] : viewSampleProgress(env.db, target, checkpoint.transcriptId, to)),
    ...(await viewCheckpointStatements(
      env.db,
      target,
      checkpoint,
      to,
      state,
      metadata,
      now,
      prepared.rows.reduce((n, row) => Math.max(n, Number(row.values.created_at)), 0) || null,
      fidelity,
    )),
  ];
  if (target.leaseToken === null && prepared.rows.length)
    writes.push(
      ...publicationVersionStatements(env.db, target.projectId, target.sessionId, attempt, prepared.rows, false),
      ...stampVersionStatements(env.db, target, attempt, prepared.rows),
      ...finishVersionStatements(env.db, target.projectId, target.sessionId, attempt),
      ...live.after,
    );
  if (target.leaseToken === null) writes.push(...liveFrontierMirrorStatements(env.db, target, checkpoint.transcriptId));
  const remaining = remainingContentBudget(env.db);
  if (writes.length > remaining.statements) throw new Error('content_statement_budget_exhausted');
  if (remaining.wallMs <= 0) throw new Error('content_wall_budget_exhausted');
  await env.db.batch(writes);
}
