import { viewTerminalSql, viewTerminalParams } from './view-terminal.js';
import type { RelationalStore, ServerEnv } from '../core/adapters.js';
import { measuredContentEnv, remainingContentBudget } from '../core/content-budget.js';
import { contentAssertion } from '../core/registered-content.js';
import { sha256Hex } from '../hash.js';
import {
  parseOnce,
  PARSER_VERSION,
  TRANSCRIPT_IDLE_MS,
  type ParseTarget,
  type PassLimits,
  type KeyClaim,
  type ParsePersistence,
} from './parse.js';
import { promptOwners, type ParserState, type PromptOwner } from './parsers/index.js';
import { prepareViewRows, writeViewWindow, viewSourceReceipts } from './view-writer.js';
import { viewWriteGuard, type ViewWriteTarget } from './view-guard.js';
import { manifestStatements } from './view-lifecycle.js';
import { failViewBuild, VIEW_BUILD_LEASE_MS } from './view-build-queue.js';

const VIEW_PARSE_FAILURES: Readonly<Record<string, string>> = {
  identity_collision: 'identity_collision',
  view_record_too_large: 'record_too_large',
  content_archive_missing: 'blob_absent',
  view_body_proof_absent: 'content_corrupt',
  view_body_digest: 'content_corrupt',
  content_archive_size_mismatch: 'content_corrupt',
  content_archive_digest_mismatch: 'content_corrupt',
  content_text_invalid: 'content_corrupt',
  view_checkpoint_incomplete: 'checkpoint_corrupt',
  view_checkpoint_digest: 'checkpoint_corrupt',
};

/** The common parser receives instance-owned persistence rather than the legacy event writer. */
export async function parseViewOnce(
  env: Pick<ServerEnv, 'db' | 'blobs'>,
  target: ViewWriteTarget,
  now: number,
  limits: PassLimits,
) {
  const measured = measuredContentEnv(env, { ...remainingContentBudget(env.db), enforceWall: true }),
    db = measured.env.db;
  const checkpointRead = db
    .prepare(
      `SELECT t.*,c.transcript_id checkpoint_id,c.parsed_offset checkpoint_offset,c.parser_context checkpoint_context,
    c.open_prompt_id checkpoint_prompt,c.parse_segment_lines checkpoint_lines,c.ordinal,c.lost_context checkpoint_lost,c.fidelity checkpoint_fidelity,s.ended_at session_end,s.machine_id session_machine,s.working_since,s.last_turn_end_at
    FROM view_checkpoints c JOIN transcripts t ON t.project_id=c.project_id AND t.transcript_id=c.transcript_id
    JOIN sessions s ON s.project_id=t.project_id AND s.session_id=t.session_id
    WHERE c.project_id=? AND c.instance_id=? AND (c.parse_error IS NULL OR c.parse_error='awaiting_bytes' AND t.size>COALESCE(c.parse_awaited_size,-1))
      AND (c.parsed_offset<t.size OR ${viewTerminalSql('c', 't', 's')}) ORDER BY c.ordinal LIMIT 1`,
    )
    .bind(target.projectId, target.instanceId, ...viewTerminalParams(now, limits.completeFile));
  // The guard, the manifest and the next checkpoint's read travel in one round trip.
  const opened = await db.batch([
    ...viewWriteGuard(db, target, now),
    ...manifestStatements(db, target.projectId, target.sessionId, target.instanceId),
    checkpointRead,
  ]);
  const row = (opened.at(-1)?.results[0] as Record<string, unknown> | undefined) ?? null;
  if (row === null) return null;
  const context =
    typeof row.checkpoint_context === 'string' ? (JSON.parse(row.checkpoint_context) as Record<string, unknown>) : null;
  const transcriptId = String(row.checkpoint_id),
    offset = Number(row.checkpoint_offset);
  const checkpoint = {
    transcriptId,
    offset,
    context: typeof row.checkpoint_context === 'string' ? row.checkpoint_context : null,
    openPromptId: typeof row.checkpoint_prompt === 'string' ? row.checkpoint_prompt : null,
  };
  const receipts = new Map<number, number>();
  const claims: KeyClaim[] = [],
    owners = new Map<string, PromptOwner>();
  const updateError = async (failure: string) => {
    await db.batch([
      ...viewWriteGuard(db, target, now),
      db
        .prepare(
          `UPDATE view_checkpoints SET parse_error=?,parse_failed_at=?,parse_awaited_size=? WHERE project_id=? AND instance_id=? AND transcript_id=?`,
        )
        .bind(failure, now, row.size, target.projectId, target.instanceId, transcriptId),
    ]);
    if (target.leaseToken !== null && failure !== 'awaiting_bytes') await failViewBuild(db, target, failure, now);
  };
  const persistence: ParsePersistence = {
    sourceTimes: (offsets) => viewSourceReceipts(db, target.projectId, transcriptId, offsets, receipts),
    checkpoint: async (digest) => {
      const held = (
        await db
          .prepare(
            `SELECT chunk_index,chunk_count,payload FROM view_checkpoint_chunks WHERE project_id=? AND instance_id=? AND transcript_id=? AND cursor_offset=? ORDER BY chunk_index`,
          )
          .bind(target.projectId, target.instanceId, transcriptId, offset)
          .all<{ chunk_index: number; chunk_count: number; payload: string }>()
      ).results;
      if (!held.length || held.some((c, i) => c.chunk_index !== i || c.chunk_count !== held.length))
        throw new Error('view_checkpoint_incomplete');
      const encoded = held.map((c) => c.payload).join('');
      if ((await sha256Hex(encoded)) !== digest) throw new Error('view_checkpoint_digest');
      return JSON.parse(encoded) as ParserState;
    },
    owners: async (keys) => {
      const held = (
        await db
          .prepare(
            `SELECT source_key,source_thread,source_record FROM view_key_owners
        WHERE project_id=? AND instance_id=? AND source_key IN(SELECT value FROM json_each(?))`,
          )
          .bind(target.projectId, target.instanceId, JSON.stringify([...keys.keys()]))
          .all<{ source_key: string; source_thread: string; source_record: string }>()
      ).results;
      for (const c of held) owners.set(c.source_key, { thread: c.source_thread, record: c.source_record });
      for (const c of claims) if (!owners.has(c.key)) owners.set(c.key, { thread: c.thread, record: c.record });
      return promptOwners([...owners]);
    },
    claim: async (incoming) => {
      claims.push(...incoming);
    },
    stop: updateError,
    awaitBytes: async () => {
      await updateError('awaiting_bytes');
    },
    header: async (metadata) => {
      await db.batch([
        ...viewWriteGuard(db, target, now),
        db
          .prepare(
            `UPDATE view_checkpoints SET parser_context=? WHERE project_id=? AND instance_id=? AND transcript_id=?`,
          )
          .bind(JSON.stringify(metadata), target.projectId, target.instanceId, transcriptId),
      ]);
    },
    publish: async (window) => {
      const source = {
        projectId: target.projectId,
        sessionId: target.sessionId,
        eventId: target.instanceId,
        tokenId: String(row.token_id),
        envelopeHash: target.instanceId,
        sourceKind: 'view' as const,
        resourceId: target.instanceId,
      };
      const prepared = await prepareViewRows(
        measured.env,
        target,
        window.events,
        {
          transcriptId,
          end: window.to,
          ordinal: Number(row.ordinal),
          receivedAt: Number(row.last_received_at),
          machineId: String(row.machine_id),
          receipts,
          lostContext: Number(row.checkpoint_lost) === 1,
          sessionMachineId: typeof row.session_machine === 'string' ? row.session_machine : null,
        },
        source,
        now,
      );
      const findings = window.state.findings ?? [];
      if (findings.length)
        prepared.proofs.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO view_findings(project_id,instance_id,session_id,kind,record_id,n)
        SELECT ?,?,?,json_extract(value,'$.kind'),json_extract(value,'$.recordId'),json_extract(value,'$.offset') FROM json_each(?)`,
            )
            .bind(target.projectId, target.instanceId, target.sessionId, JSON.stringify(findings)),
        );
      delete window.state.findings;
      const unattributed = window.state.unattributed ?? [];
      if (unattributed.length)
        prepared.proofs.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO view_findings(project_id,instance_id,session_id,kind,record_id,n,detail)
        SELECT ?,?,?,'unattributed',?,json_extract(value,'$.offset'),json_extract(value,'$.kind') FROM json_each(?)`,
            )
            .bind(target.projectId, target.instanceId, target.sessionId, transcriptId, JSON.stringify(unattributed)),
        );
      delete window.state.unattributed;
      const input = JSON.stringify(claims);
      prepared.proofs.unshift(
        ...contentAssertion(
          db,
          `NOT EXISTS(SELECT 1 FROM json_each(?) j JOIN view_key_owners o ON o.project_id=? AND o.instance_id=?
        AND o.source_key=json_extract(j.value,'$.key') WHERE o.source_thread<>json_extract(j.value,'$.thread') OR o.source_record<>json_extract(j.value,'$.record'))`,
          [input, target.projectId, target.instanceId],
        ),
        db
          .prepare(
            `INSERT OR IGNORE INTO view_key_owners(project_id,instance_id,session_id,source_key,source_thread,source_record,source_transcript_id,source_offset,created_at)
          SELECT ?,?,?,json_extract(value,'$.key'),json_extract(value,'$.thread'),json_extract(value,'$.record'),?,?,? FROM json_each(?)`,
          )
          .bind(target.projectId, target.instanceId, target.sessionId, transcriptId, offset, now, input),
        ...(target.leaseToken === null
          ? []
          : [
              db
                .prepare(
                  `UPDATE view_instances SET lease_expires_at=? WHERE project_id=? AND instance_id=? AND lease_token IS ?`,
                )
                .bind(now + VIEW_BUILD_LEASE_MS, target.projectId, target.instanceId, target.leaseToken),
            ]),
      );
      await writeViewWindow(
        measured.env,
        target,
        prepared,
        { ...checkpoint, openPromptId: window.openPromptId, segmentLines: window.segmentLines },
        window.to,
        window.state,
        window.metadata,
        now,
        window.fidelity,
      );
      return measured.usage.roundTrips + measured.usage.blobCalls;
    },
  };
  const scheme =
    row.prompt_identity_scheme === 'offset-v1'
      ? 'offset-v2'
      : row.prompt_identity_scheme === 'stamp-or-offset-v1'
        ? 'stamp-or-offset-v2'
        : row.prompt_identity_scheme;
  const parseTarget: ParseTarget = {
    projectId: target.projectId,
    sessionId: target.sessionId,
    transcriptId,
    machineId: String(row.machine_id),
    tokenId: String(row.token_id),
    agent: typeof row.agent === 'string' ? row.agent : null,
    parsedOffset: offset,
    segmentLines: Number(row.checkpoint_lines ?? 0),
    size: Number(row.size),
    fidelity: typeof row.checkpoint_fidelity === 'string' ? row.checkpoint_fidelity : null,
    scheme: scheme as ParseTarget['scheme'],
    recordScheme: 'source-record-v1',
    openPromptId: checkpoint.openPromptId,
    promptIdentityStale: false,
    parserContext: context,
    lastReceivedAt: Number(row.last_received_at),
    sessionEndedAt: row.session_end === null ? null : Number(row.session_end),
    imported: row.imported_at !== null,
    turnEnded: row.working_since === null && Number(row.last_turn_end_at) > Number(context?.mycoParserReplyLatestAt),
    persistence,
  };
  if (offset === parseTarget.size && !limits.completeFile && context?.mycoParserUnfinished !== 1) return null;
  try {
    const report = await parseOnce(measured.env, parseTarget, now, limits);
    return { ...report, unread: report.nextOffset === null ? 0 : Math.max(0, parseTarget.size - report.nextOffset) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const failure = error.message.startsWith('view_record_refused:')
      ? 'event_refused'
      : VIEW_PARSE_FAILURES[error.message];
    if (failure === undefined) throw error;
    await updateError(failure);
    return { derived: 0, calls: measured.usage.roundTrips + measured.usage.blobCalls, nextOffset: null, failure, unread: 0 };
  }
}
