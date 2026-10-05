/**
 * Reading a held transcript into its rows, and pruning the bytes afterwards.
 *
 * Three properties carry this feature and each is asserted against the store
 * rather than against the parser in isolation:
 *
 *   - a pass spends a BOUNDED number of store calls, whatever the shape of the
 *     transcript. The bound is what keeps a pass inside a hosted runtime's
 *     per-invocation cap, and a byte bound would not have provided it: a turn
 *     of many small events and one of few large events cost very different
 *     numbers of calls for the same bytes.
 *   - the cursor never advances past an event that did not land. This is the
 *     one defect that would lose rows silently and in bulk.
 *   - many passes and one pass produce the same rows.
 */
import { D1_BOUND_PARAMETER_CEILING, registerBlob } from './helpers/d1.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { MemoryBlobStore } from './helpers/fixtures.js';
import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  AWAITING_BYTES, eventGroups, TRANSCRIPT_PRODUCER, PARSER_VERSION, TRANSCRIPT_PARSE_BATCH_PAYLOAD_BYTES, laneSelectionSql, parseOnce, parseTranscripts, pendingTranscripts, rereadTranscripts,
  TRANSCRIPT_PARSE_EVENTS_PER_BATCH, TRANSCRIPT_PARSE_MALFORMED_LIMIT, TRANSCRIPT_REPAIRS_PER_WAKE,
  TRANSCRIPT_PARSE_BYTES_PER_READ, TRANSCRIPT_PARSE_SEGMENTS_PER_READ, TRANSCRIPT_PARSE_RECORD_BYTES, TRANSCRIPT_IDLE_MS,
} from '@myco-server-worker/ingest/parse.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';
import { freeOrphanedBlobs, TOMBSTONE_SWEEP_GRACE_MS, transcriptRetention, transcriptRetentionDays } from '@myco-server-worker/ingest/retention.js';
import { blobHeld } from '@myco-server-worker/core/blob-references.js';
import { listTranscripts } from '@myco-server-worker/read/transcript.js';
import { listSessions, listSessionSummaries } from '@myco-server-worker/read/sessions.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import { sessionMaterial, titleReadySessions } from '@myco-server-worker/core/titling.js';
import { SESSION_END_SETTLE_MS } from '@myco-server-worker/constants.js';
import { listUnprocessedPrompts } from '@myco-server-worker/read/prompts.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqliteEnv, count, registeredObject, uuid } from './helpers/fixtures.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sha256HexOf, uuidv5 } from '@myco-server-worker/hash.js';
import { checkProject, releaseProvenance } from '@myco-server-worker/core/release-provenance.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { REPO, X, fakeGithub } from './helpers/github-fake.js';

const NOW = Date.parse('2027-01-01T00:00:00Z');
const PROJECT = 'proj_1';
const SESSION = 's1';
const TRANSCRIPT = 'tx_0123456789abcdef0123456789abcdef';
const MACHINE = 'machine_1';

const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;

/** A transcript body with `turns` prompt-and-reply pairs, each also making a tool call. */
function body(turns: number): string {
  // Distinct instants per line, as a real transcript carries: the rows a turn
  // produces are ordered by them.
  const at = (n: number) => new Date(Date.parse('2026-09-01T10:00:00Z') + n * 1000).toISOString();
  let out = '';
  for (let i = 0; i < turns; i += 1) {
    out += line({ type: 'user', promptId: `${uuid(i + 1)}`, message: { content: `prompt ${i}` }, timestamp: at(i * 3) });
    out += line({ type: 'assistant', message: { content: [{ type: 'text', text: `reply ${i}` }, { type: 'tool_use', id: `t${i}`, name: 'Read', input: { i } }] }, timestamp: at(i * 3 + 1) });
    out += line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] }, timestamp: at(i * 3 + 2) });
  }
  return out;
}

/** A store holding one transcript whose bytes are split into `sliceBytes` segments. */
async function rig(text: string, sliceBytes = 1 << 20, opts: { agent?: string } = {}) {
  const { sqlite, serverEnv } = sqliteEnv();
  const issued = await issueMemberToken(serverEnv.db, { memberId: 'mem_machine_1', machineId: MACHINE }, NOW);
  const bytes = new TextEncoder().encode(text);

  sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
              VALUES (?, ?, ?, ?, ?, ?)`, [PROJECT, SESSION, MACHINE, issued.tokenId, NOW, NOW]);
  sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
             [PROJECT, TRANSCRIPT, SESSION, MACHINE, opts.agent ?? 'claude-code', bytes.length, 1, NOW, NOW, issued.tokenId]);

  for (let at = 0; at < bytes.length; at += sliceBytes) {
    const slice = bytes.subarray(at, Math.min(at + sliceBytes, bytes.length));
    const key = await sha256HexOf(slice);
    const objectKey = registerBlob(sqlite, { projectId: PROJECT, key, size: slice.length, tokenId: issued.tokenId, receivedAt: NOW });
    await serverEnv.blobs.put(objectKey, new Blob([slice]).stream());
    sqlite.run(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [PROJECT, TRANSCRIPT, at, slice.length, key, `e${at}`, NOW, NOW, issued.tokenId]);
  }
  return { sqlite, env: { db: serverEnv.db, blobs: serverEnv.blobs }, serverEnv, tokenId: issued.tokenId };
}

const target = (sqlite: Database) => {
  const row = sqlite.query(`SELECT parsed_offset, size, parse_error, fidelity FROM transcripts`).get() as
    { parsed_offset: number; size: number; parse_error: string | null; fidelity: string | null };
  return row;
};

/** The calls one direct pass may spend in these cases, and no deadline: what `parseTranscripts` hands a pass from its budget. */
const PASS_CALLS = 12;
const LIMITS = { calls: PASS_CALLS, deadline: Number.POSITIVE_INFINITY, clock: () => 0, completeFile: true };
/** How many transcripts still owe a pass. */
const pendingCount = async (db: Parameters<typeof pendingTranscripts>[0], now = NOW): Promise<number> => (await pendingTranscripts(db, now)).transcripts;

describe('repair lane priority', () => {
  const selected = (sqlite: Database, lane: 'live' | 'imported' | 'repair') =>
    (sqlite.query(laneSelectionSql(lane, 100, NOW).replace('?', String(PARSER_VERSION))).all() as { transcript_id: string }[])
      .map((row) => row.transcript_id);

  it.each(['upgrade', 'manual'] as const)('parses a newly received live segment on the next tick beside a large %s reread, then completes the repair', async (mode) => {
    const { sqlite, serverEnv, tokenId } = await rig(body(2_000), TRANSCRIPT_PARSE_BYTES_PER_READ);
    sqlite.run('UPDATE transcripts SET parsed_offset = size, parsed_at = ?, parser_version = ?', [NOW, mode === 'upgrade' ? 3 : PARSER_VERSION]);
    if (mode === 'upgrade') await parseTranscripts(serverEnv, NOW, { budget: { calls: 2, wallMs: 1000 }, clock: () => 0 });
    else await rereadTranscripts(serverEnv.db, { projectId: PROJECT, sessionId: SESSION });
    expect(selected(sqlite, 'repair')).toEqual([TRANSCRIPT]);

    const text = line({ type: 'user', promptId: uuid(50_000), message: { content: 'live segment' }, timestamp: new Date(NOW).toISOString() });
    const bytes = new TextEncoder().encode(text);
    const key = await sha256HexOf(bytes);
    const objectKey = registerBlob(sqlite, { projectId: PROJECT, key, size: bytes.length, tokenId, receivedAt: NOW });
    await serverEnv.blobs.put(objectKey, new Blob([bytes]).stream());
    const liveId = 'tx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const receipt = await ingestEvent(serverEnv.db, { projectId: PROJECT, machineId: MACHINE, tokenId, now: NOW, bodyBytes: 0 }, {
      eventId: uuid(50_001), sessionId: 'live-priority', kind: 'transcript.segment', channel: 'cli', createdAt: NOW,
      producer: { adapter: 'claude-code', version: '1' }, payload: { transcriptId: liveId, baseOffset: 0, length: bytes.length, blob: key, agent: 'claude-code' },
    });
    expect(receipt.persisted).toBe(true);
    expect(selected(sqlite, 'live')).toEqual([liveId]);
    expect(await pendingCount(serverEnv.db)).toBe(2);
    const passes: string[] = [];
    const first = await parseTranscripts(serverEnv, NOW + 1, { budget: { calls: 24, wallMs: 10_000 }, clock: () => 0,
      passes: { started: (id) => { passes.push(id); }, ended: () => {} } });
    expect(passes[0]).toBe(liveId);
    expect(passes.filter((id) => id === TRANSCRIPT)).toHaveLength(1);
    expect(sqlite.query('SELECT text FROM prompt_batches WHERE session_id = ?').all('live-priority')).toEqual([{ text: 'live segment' }]);
    expect(first.more).toBe(true);
    const repaired = sqlite.query('SELECT parsed_offset, size FROM transcripts WHERE transcript_id = ?').get(TRANSCRIPT) as { parsed_offset: number; size: number };
    expect(repaired.parsed_offset).toBeGreaterThan(0);
    expect(repaired.parsed_offset).toBeLessThan(repaired.size);
    for (let tick = 0; tick < 200 && await pendingCount(serverEnv.db) > 0; tick += 1)
      await parseTranscripts(serverEnv, NOW + tick + 2, { budget: { calls: 100, wallMs: 10_000 }, clock: () => 0 });
    expect(await pendingCount(serverEnv.db)).toBe(0);
    expect(sqlite.query('SELECT parsed_offset = size AS complete FROM transcripts WHERE transcript_id = ?').get(TRANSCRIPT)).toEqual({ complete: 1 });
  });

  it.each(['calls', 'wall'] as const)('rotates repair cursors while live and imported transcripts remain pending under %s pressure', async (pressure) => {
    const { sqlite, serverEnv } = await rig(body(200));
    sqlite.run('UPDATE transcripts SET parsed_offset = size, parsed_at = ?, parser_version = ?', [NOW, PARSER_VERSION]);
    await rereadTranscripts(serverEnv.db, { projectId: PROJECT, sessionId: SESSION });
    for (const id of ['tx_repair_second', 'tx_live_busy', 'tx_import_busy']) {
      sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at,
        last_received_at, token_id, parsed_offset, parsed_at, parser_version, parser_context, imported_at)
        SELECT project_id, ?, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at,
          token_id, parsed_offset, parsed_at, parser_version, CASE WHEN ? = 'tx_repair_second' THEN parser_context ELSE NULL END,
          CASE WHEN ? = 'tx_import_busy' THEN ? ELSE NULL END FROM transcripts WHERE transcript_id = ?`, [id, id, id, NOW, TRANSCRIPT]);
      sqlite.run(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
        SELECT project_id, ?, base_offset, length, blob_key, event_id, created_at, received_at, token_id FROM transcript_segments WHERE transcript_id = ?`, [id, TRANSCRIPT]);
    }
    const visited: string[] = [];
    for (let tick = 0; tick < 2; tick += 1) {
      const passes: string[] = [];
      let elapsed = 0;
      await parseTranscripts(serverEnv, NOW + tick + 1, { budget: { calls: 24, wallMs: 100 }, clock: () => elapsed,
        passes: { started: (id) => { passes.push(id); if (pressure === 'wall' && id === 'tx_live_busy') elapsed = 60; }, ended: () => {} } });
      expect(passes[0]).toBe('tx_live_busy');
      if (pressure === 'wall') expect(passes[1]).toBe(tick === 0 ? TRANSCRIPT : 'tx_repair_second');
      expect(passes).toContain('tx_import_busy');
      visited.push(...passes.filter((id) => id === TRANSCRIPT || id === 'tx_repair_second'));
      const lanes = ['live', 'imported', 'repair'] as const;
      const ids = lanes.flatMap((lane) => selected(sqlite, lane));
      expect(new Set(ids).size).toBe(ids.length);
      expect(await pendingCount(serverEnv.db)).toBe(ids.length);
    }
    expect(visited).toEqual([TRANSCRIPT, 'tx_repair_second']);
  });

  it.each([
    { mycoParserState: { legacyReplies: { until: 100_000 } } },
    { mycoParserState: { chunked: true }, mycoParserRepair: { status: 'replaying' } },
    { mycoParserState: { chunked: true } },
  ])('selects an already deployed repair checkpoint in its repair lane: %j', async (context) => {
    const { sqlite, serverEnv } = await rig(body(2));
    sqlite.run('UPDATE transcripts SET parsed_at = ?, parser_version = ?, parser_context = ?', [NOW, PARSER_VERSION, JSON.stringify(context)]);
    expect(selected(sqlite, 'live')).toEqual([]);
    expect(selected(sqlite, 'repair')).toEqual([TRANSCRIPT]);
    expect(await pendingCount(serverEnv.db)).toBe(1);
  });

  it('promotes a rewound transcript when new bytes arrive in the same millisecond, and partitions the pending count', async () => {
    const { sqlite, serverEnv, tokenId } = await rig(body(2));
    sqlite.run('UPDATE transcripts SET parsed_offset = size, parsed_at = ?, parser_version = ?', [NOW, PARSER_VERSION]);
    await rereadTranscripts(serverEnv.db, { projectId: PROJECT, sessionId: SESSION });
    expect(selected(sqlite, 'repair')).toEqual([TRANSCRIPT]);
    await rereadTranscripts(serverEnv.db, { projectId: PROJECT, sessionId: SESSION });
    expect(selected(sqlite, 'repair')).toEqual([TRANSCRIPT]);
    const bytes = new TextEncoder().encode(body(1));
    const key = await sha256HexOf(bytes);
    const objectKey = registerBlob(sqlite, { projectId: PROJECT, key, size: bytes.length, tokenId, receivedAt: NOW });
    await serverEnv.blobs.put(objectKey, new Blob([bytes]).stream());
    const receipt = await ingestEvent(serverEnv.db, { projectId: PROJECT, machineId: MACHINE, tokenId, now: NOW, bodyBytes: 0 }, {
      eventId: uuid(50_002), sessionId: SESSION, kind: 'transcript.segment', channel: 'cli', createdAt: NOW,
      producer: { adapter: 'claude-code', version: '1' }, payload: { transcriptId: TRANSCRIPT, baseOffset: Buffer.byteLength(body(2)), length: bytes.length, blob: key, agent: 'claude-code' },
    });
    expect(receipt.persisted).toBe(true);
    expect(selected(sqlite, 'live')).toEqual([TRANSCRIPT]);
    expect(selected(sqlite, 'repair')).toEqual([]);
    expect(await pendingCount(serverEnv.db)).toBe(1);
  });
});

describe('bounded parser upgrade repair', () => {
  it('wakes for an older flat-context EOF cursor, resumes after rewind, and repairs plans and failed calls once', async () => {
    const text = line({ type: 'user', promptId: uuid(1), message: { content: 'start' } })
      + line({ type: 'assistant', message: { content: [{ type: 'text', text: '<ultraplan># First</ultraplan>' }, { type: 'tool_use', id: 'old-call', name: 'Read', input: { path: 'a' } }] } })
      + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'old-call', content: 'ok' }] } })
      + line({ type: 'assistant', message: { content: [{ type: 'text', text: '<ultraplan># Second</ultraplan>' }] } })
      + line({ type: 'user', promptId: uuid(2), message: { content: 'next' } });
    const { sqlite, serverEnv, tokenId } = await rig(text);
    const toolCallId = await uuidv5('tool-call', SESSION, 'old-call');
    await ingestEvent(serverEnv.db, { projectId: PROJECT, machineId: MACHINE, tokenId, now: NOW, bodyBytes: 0 }, {
      eventId: uuid(100), sessionId: SESSION, kind: 'tool.failure', channel: 'cli', createdAt: NOW,
      producer: TRANSCRIPT_PRODUCER, payload: { toolCallId, toolName: 'Read', input: { path: 'a' }, success: false, errorMessage: 'tool call has no result in the transcript' },
    });
    sqlite.run("UPDATE transcripts SET parsed_offset = size, parser_version = 3, parser_context = '{\"source\":\"cli\"}'");
    expect((await pendingTranscripts(serverEnv.db, NOW)).transcripts).toBe(1);
    const first = await parseTranscripts(serverEnv, NOW, { budget: { calls: 2, wallMs: 1000 }, clock: () => 0 });
    expect({ cursor: target(sqlite).parsed_offset, more: first.more }).toEqual({ cursor: 0, more: true });
    for (let wake = 0; wake < 20 && (await pendingTranscripts(serverEnv.db, NOW)).transcripts > 0; wake += 1)
      await parseTranscripts(serverEnv, NOW, { budget: { calls: 4, wallMs: 1000 }, clock: () => 0 });
    expect(sqlite.query('SELECT title FROM plans ORDER BY title').all()).toEqual([{ title: 'First' }, { title: 'Second' }]);
    expect(sqlite.query('SELECT tool_call_id, input, success, output_preview, error_message FROM tool_calls').all())
      .toEqual([{ tool_call_id: toolCallId, input: '{"path":"a"}', success: 1, output_preview: 'ok', error_message: null }]);
    expect(JSON.parse((sqlite.query('SELECT parser_context FROM transcripts').get() as { parser_context: string }).parser_context).mycoParserMeta)
      .toEqual({ source: 'cli' });
    const counts = sqlite.query('SELECT (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM plans) AS plans').get();
    await parseTranscripts(serverEnv, NOW);
    expect(sqlite.query('SELECT (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM plans) AS plans').get()).toEqual(counts);
    expect(target(sqlite)).toMatchObject({ parsed_offset: target(sqlite).size, parse_error: null });
  });

  it('records missing raw bytes as a repair omission once and does not keep the Deployment awake', async () => {
    const { sqlite, serverEnv } = await rig(body(1));
    sqlite.run('DELETE FROM transcript_segments');
    sqlite.run('UPDATE transcripts SET parsed_offset = size, parser_version = 3');
    await parseTranscripts(serverEnv, NOW);
    const stored = sqlite.query('SELECT parser_version, parser_context FROM transcripts').get() as { parser_version: number; parser_context: string };
    expect(JSON.parse(stored.parser_context).mycoParserRepair.status).toBe('raw_absent');
    expect((await pendingTranscripts(serverEnv.db, NOW)).transcripts).toBe(0);
    await parseTranscripts(serverEnv, NOW);
    expect(sqlite.query('SELECT parser_version, parser_context FROM transcripts').get()).toEqual(stored);
  });

  it('keeps a partial older cursor\'s raw-absent repair reason when the unavailable prefix is skipped', async () => {
    const text = body(2);
    const { sqlite, serverEnv } = await rig(text);
    sqlite.run('UPDATE transcripts SET parsed_offset = ?, parser_version = 3', [Buffer.byteLength(body(1))]);
    sqlite.run('DELETE FROM transcript_segments');
    await parseTranscripts(serverEnv, NOW, { budget: { calls: 2, wallMs: 1000 }, clock: () => 0 });
    const repair = () => {
      const row = sqlite.query('SELECT parsed_offset, parser_version, parser_context FROM transcripts').get() as
        { parsed_offset: number; parser_version: number; parser_context: string };
      return { cursor: row.parsed_offset, version: row.parser_version, status: JSON.parse(row.parser_context).mycoParserRepair?.status };
    };
    expect(repair()).toEqual({ cursor: Buffer.byteLength(body(1)), version: PARSER_VERSION, status: 'raw_absent' });
    await parseTranscripts(serverEnv, NOW, { budget: { calls: 4, wallMs: 1000 }, clock: () => 0 });
    expect(repair()).toEqual({ cursor: Buffer.byteLength(text), version: PARSER_VERSION, status: 'raw_absent' });
    expect(await pendingCount(serverEnv.db)).toBe(0);
  });

  it('clears stale checkpoint chunks when repair or a manual reread rewinds their cursor', async () => {
    const { sqlite, serverEnv } = await rig(body(1));
    const chunked = JSON.stringify({ source: 'cli', mycoParserState: { chunked: true, digest: 'old-checkpoint' }, mycoParserUnfinished: 1 });
    const insertChunk = () => sqlite.run(`INSERT INTO transcript_parser_state_chunks
      (project_id, transcript_id, cursor_offset, chunk_index, chunk_count, payload) VALUES (?, ?, ?, 0, 1, '{}')`,
    [PROJECT, TRANSCRIPT, target(sqlite).parsed_offset]);
    const chunks = () => count(sqlite, 'transcript_parser_state_chunks');
    sqlite.run('UPDATE transcripts SET parsed_offset = size, parser_version = 3, parser_context = ?', [chunked]);
    insertChunk();
    expect(chunks()).toBe(1);
    await parseTranscripts(serverEnv, NOW, { budget: { calls: 2, wallMs: 1000 }, clock: () => 0 });
    expect(target(sqlite).parsed_offset).toBe(0);
    expect(chunks()).toBe(0);

    sqlite.run('UPDATE transcripts SET parsed_offset = size, parser_version = ?, parser_context = ?', [PARSER_VERSION, chunked]);
    insertChunk();
    expect(chunks()).toBe(1);
    expect(await rereadTranscripts(serverEnv.db, { projectId: PROJECT, sessionId: SESSION })).toBe(1);
    expect(target(sqlite).parsed_offset).toBe(0);
    expect(chunks()).toBe(0);
  });

  it('prepares at most four older cursors per wake before parsing their bytes', async () => {
    const { sqlite, serverEnv } = await rig(body(1));
    sqlite.run("UPDATE transcripts SET parsed_offset = size, parser_version = 3, parser_context = '{\"source\":\"cli\"}'");
    for (let index = 1; index <= TRANSCRIPT_REPAIRS_PER_WAKE; index += 1) {
      const transcriptId = `tx_repair_${index}`;
      sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count,
        first_received_at, last_received_at, token_id, parsed_offset, parser_version, parser_context)
        SELECT project_id, ?, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at,
          token_id, parsed_offset, parser_version, parser_context FROM transcripts WHERE transcript_id = ?`, [transcriptId, TRANSCRIPT]);
      sqlite.run(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
        SELECT project_id, ?, base_offset, length, blob_key, event_id, created_at, received_at, token_id
          FROM transcript_segments WHERE transcript_id = ?`, [transcriptId, TRANSCRIPT]);
    }
    const repairRows = () => sqlite.query(`SELECT transcript_id, parsed_offset, parser_version, parser_context
      FROM transcripts ORDER BY transcript_id`).all() as Array<{ transcript_id: string; parsed_offset: number; parser_version: number; parser_context: string }>;
    await parseTranscripts(serverEnv, NOW, { budget: { calls: 2, wallMs: 1000 }, clock: () => 0 });
    const first = repairRows();
    expect(first.filter((row) => JSON.parse(row.parser_context).mycoParserRepair?.status === 'replaying')).toHaveLength(TRANSCRIPT_REPAIRS_PER_WAKE);
    expect(first.filter((row) => row.parser_version === 3 && row.parsed_offset > 0)).toHaveLength(1);
    await parseTranscripts(serverEnv, NOW, { budget: { calls: 2, wallMs: 1000 }, clock: () => 0 });
    expect(repairRows().every((row) => row.parsed_offset === 0
      && JSON.parse(row.parser_context).mycoParserRepair?.status === 'replaying')).toBe(true);
  });

  it.each([
    { removed: 'first', status: 'raw_prefix_pruned' },
    { removed: 'last', status: 'raw_gap' },
  ])('names a $status omission when the $removed source segment is gone', async ({ removed, status }) => {
    const text = body(2);
    const { sqlite, serverEnv } = await rig(text, Buffer.byteLength(body(1)));
    sqlite.run('UPDATE transcripts SET parsed_offset = size, parser_version = 3');
    sqlite.run(`DELETE FROM transcript_segments WHERE base_offset ${removed === 'first' ? '=' : '>'} 0`);
    await parseTranscripts(serverEnv, NOW, { budget: { calls: 2, wallMs: 1000 }, clock: () => 0 });
    const row = sqlite.query('SELECT parsed_offset, size, parser_version, parser_context FROM transcripts').get() as
      { parsed_offset: number; size: number; parser_version: number; parser_context: string };
    expect({ cursor: row.parsed_offset, size: row.size, version: row.parser_version,
      status: JSON.parse(row.parser_context).mycoParserRepair.status }).toEqual({ cursor: row.size, size: Buffer.byteLength(text), version: PARSER_VERSION, status });
    expect(await pendingCount(serverEnv.db)).toBe(0);
    await parseTranscripts(serverEnv, NOW, { budget: { calls: 2, wallMs: 1000 }, clock: () => 0 });
    expect(sqlite.query('SELECT parsed_offset, parser_version, parser_context FROM transcripts').get())
      .toEqual({ parsed_offset: row.parsed_offset, parser_version: row.parser_version, parser_context: row.parser_context });
  });
});

/** Drives passes to completion, counting database calls so the bound can be asserted. */
async function drain(env: { db: unknown; blobs: unknown }, sqlite: Database, max = 50): Promise<number> {
  let passes = 0;
  while (passes < max && target(sqlite).parsed_offset < target(sqlite).size && target(sqlite).parse_error === null) {
    const t = sqlite.query(`SELECT project_id, transcript_id, session_id, machine_id, token_id, agent, size, parsed_offset, fidelity, open_prompt_id, parser_context, imported_at FROM transcripts`).get() as Record<string, unknown>;
    const before = target(sqlite).parsed_offset;
    await parseOnce(env as never, {
      projectId: t.project_id as string, transcriptId: t.transcript_id as string, sessionId: t.session_id as string,
      machineId: t.machine_id as string, tokenId: t.token_id as string, agent: t.agent as string,
      size: t.size as number, parsedOffset: t.parsed_offset as number, fidelity: null,
      openPromptId: (t.open_prompt_id as string | null) ?? null,
      parserContext: typeof t.parser_context === 'string' ? JSON.parse(t.parser_context) : null,
      imported: t.imported_at !== null && t.imported_at !== undefined,
    }, NOW, LIMITS);
    passes += 1;
    if (target(sqlite).parsed_offset === before) break;
  }
  return passes;
}

describe('parsing a held transcript', () => {
  it('records the file a parsed Edit names, and a release check maps the session to that package', async () => {
    const at = (n: number) => new Date(Date.parse('2026-09-01T10:00:00Z') + n * 1000).toISOString();
    const text = line({ type: 'user', promptId: uuid(1), message: { content: 'edit b' }, timestamp: at(0) })
      + line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'te', name: 'Edit',
        input: { file_path: '/Users/dev/repo/packages/b/src/y.ts', old_string: 'a', new_string: 'b' } }] }, timestamp: at(1) })
      + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'te', content: 'ok' }] }, timestamp: at(2) });
    const { sqlite, env, serverEnv } = await rig(text);
    await drain(env, sqlite);
    expect(sqlite.query('SELECT tool_name, files_affected FROM tool_calls').all())
      .toEqual([{ tool_name: 'Edit', files_affected: JSON.stringify(['/Users/dev/repo/packages/b/src/y.ts']) }]);

    const store = releaseProvenance(serverEnv.db, deploymentSecretStore(serverEnv.db, serverEnv.wrappingKey));
    await store.save(PROJECT, { revision: null, enabled: true, githubRepo: 'o/r', productionRefs: ['refs/tags/a/v*', 'refs/tags/b/v*'],
      integrationRefs: ['main'], packageMap: [{ pathGlob: 'packages/a/', tagPattern: 'refs/tags/a/v*' }, { pathGlob: 'packages/b/', tagPattern: 'refs/tags/b/v*' }],
      includeUnknown: true, maxLookups: 50 }, 'mem_1', NOW);
    sqlite.run(`INSERT INTO knowledge_git_provenance (project_id, identity_key, session_id, capture_point, captured_at, head_sha, status_hash, created_at)
      VALUES (?, ?, ?, 'session_end', ?, ?, '', ?)`, [PROJECT, `session:${SESSION}:session_end`, SESSION, NOW, X, NOW]);
    await checkProject(serverEnv.db, deploymentSecretStore(serverEnv.db, serverEnv.wrappingKey), fakeGithub(REPO), PROJECT, NOW);
    const state = sqlite.query(`SELECT state, basis_ref, json_extract(evidence_json, '$.package_patterns') AS patterns
      FROM knowledge_release_state WHERE record_id = ?`).get(SESSION);
    expect(state).toEqual({ state: 'released', basis_ref: 'refs/tags/b/v2.0.0', patterns: JSON.stringify(['refs/tags/b/v*']) });
  });

  const codexMessage = (role: string, text: string) => line({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } });

  it('finishes a large record across segments before reading the following human turn', async () => {
    const text = line({ type: 'session_meta', payload: { source: 'cli' } })
      + line({ type: 'event_msg', payload: { type: 'item_completed', padding: 'x'.repeat(2 * TRANSCRIPT_PARSE_BYTES_PER_READ) } })
      + codexMessage('user', 'Allow ad-hoc work regardless of the automatic cap')
      + codexMessage('assistant', 'Ad-hoc work remains available');
    const { sqlite, env } = await rig(text, TRANSCRIPT_PARSE_BYTES_PER_READ * 1.5, { agent: 'codex' });
    await drain(env, sqlite);
    expect(target(sqlite)).toMatchObject({ parsed_offset: Buffer.byteLength(text), parse_error: null });
    expect(sqlite.query('SELECT text FROM prompt_batches').all()).toEqual([{ text: 'Allow ad-hoc work regardless of the automatic cap' }]);
    expect(sqlite.query('SELECT r.text FROM responses r JOIN prompt_batches p ON p.prompt_id = r.prompt_id').all()).toEqual([{ text: 'Ad-hoc work remains available' }]);
  });

  it('reads a final record its writer never ended with a newline', async () => {
    const text = codexMessage('user', 'Written whole, with no newline after it').trimEnd();
    const { sqlite, env } = await rig(text, TRANSCRIPT_PARSE_BYTES_PER_READ, { agent: 'codex' });
    await drain(env, sqlite);
    expect(target(sqlite)).toMatchObject({ parsed_offset: Buffer.byteLength(text), parse_error: null });
    expect(sqlite.query('SELECT text FROM prompt_batches').all()).toEqual([{ text: 'Written whole, with no newline after it' }]);
  });

  it('waits on a genuinely unfinished record without keeping it in the queue', async () => {
    const whole = codexMessage('user', 'Still being written');
    const text = whole.slice(0, whole.length - 6);
    const { sqlite, serverEnv } = await rig(text, TRANSCRIPT_PARSE_BYTES_PER_READ, { agent: 'codex' });
    await parseTranscripts(serverEnv, NOW);
    expect(target(sqlite)).toMatchObject({ parsed_offset: 0, parse_error: AWAITING_BYTES });
    expect(count(sqlite, 'prompt_batches')).toBe(0);
    expect(await pendingCount(serverEnv.db)).toBe(0);
  });

  it('surfaces a record that exceeds the bounded segment lookahead', async () => {
    const segmentBytes = 128;
    const text = codexMessage('user', 'x'.repeat(segmentBytes * (TRANSCRIPT_PARSE_SEGMENTS_PER_READ + 1)));
    const { sqlite, env } = await rig(text, segmentBytes, { agent: 'codex' });
    await drain(env, sqlite);
    expect(target(sqlite)).toMatchObject({ parsed_offset: 0, parse_error: 'record_too_large' });
    expect(count(sqlite, 'prompt_batches')).toBe(0);
  });

  it('refuses an oversized first record before combining its segments', async () => {
    const text = codexMessage('user', 'x'.repeat(TRANSCRIPT_PARSE_RECORD_BYTES));
    const { sqlite, env } = await rig(text, TRANSCRIPT_PARSE_RECORD_BYTES / 2, { agent: 'codex' });
    await drain(env, sqlite);
    expect(target(sqlite)).toMatchObject({ parsed_offset: 0, parse_error: 'record_too_large' });
    expect(count(sqlite, 'prompt_batches')).toBe(0);
  });

  it('keeps Codex replies and tools on the human turn across appended context and parse windows', async () => {
    const opening = line({ type: 'session_meta', payload: { source: 'cli' } })
      + codexMessage('user', 'Continue checking capture');
    const context = codexMessage('user', '<environment_context>Current date: 2026-09-11</environment_context>');
    const ending = line({ type: 'response_item', payload: { type: 'function_call', call_id: 'check', name: 'shell', arguments: '{}' } })
      + line({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'check', output: 'capture checked' } })
      + codexMessage('assistant', 'The capture check is complete');
    const staged = await rig(opening, 2048, { agent: 'codex' });
    await drain(staged.env, staged.sqlite);
    let size = Buffer.byteLength(opening);
    for (const text of [context, ending]) {
      const bytes = new TextEncoder().encode(text);
      const key = await sha256HexOf(bytes);
      const objectKey = registerBlob(staged.sqlite, { projectId: PROJECT, key, size: bytes.length, tokenId: staged.tokenId, receivedAt: NOW });
      await staged.serverEnv.blobs.put(objectKey, new Blob([bytes]).stream());
      staged.sqlite.run('INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [PROJECT, TRANSCRIPT, size, bytes.length, key, `e${size}`, NOW, NOW, staged.tokenId]);
      size += bytes.length;
      staged.sqlite.run('UPDATE transcripts SET size = ?', [size]);
      await drain(staged.env, staged.sqlite);
    }
    const whole = await rig(opening + context + ending, 2048, { agent: 'codex' });
    await drain(whole.env, whole.sqlite);
    for (const { sqlite, serverEnv } of [whole, staged]) {
      expect(target(sqlite).parse_error).toBeNull();
      expect(target(sqlite).parsed_offset).toBe(size);
      expect(sqlite.query('SELECT text, origin FROM prompt_batches ORDER BY text').all()).toEqual([
        { text: '<environment_context>Current date: 2026-09-11</environment_context>', origin: 'system' },
        { text: 'Continue checking capture', origin: 'user' },
      ]);
      expect(sqlite.query('SELECT p.text AS prompt, r.text AS response FROM responses r JOIN prompt_batches p ON p.prompt_id = r.prompt_id').all()).toEqual([
        { prompt: 'Continue checking capture', response: 'The capture check is complete' },
      ]);
      expect(sqlite.query('SELECT p.text AS prompt, t.output_preview AS output FROM tool_calls t JOIN prompt_batches p ON p.prompt_id = t.prompt_id').all()).toEqual([
        { prompt: 'Continue checking capture', output: 'capture checked' },
      ]);
      expect((await sessionMaterial(serverEnv.db, PROJECT, SESSION))[0].response).toContain('The capture check is complete');
    }
  });

  it('dispatches an ended Codex conversation after parsing without changing its format fidelity', async () => {
    const text = line({ type: 'session_meta', payload: { source: 'cli' } })
      + codexMessage('user', 'Read the project rules heading')
      + codexMessage('assistant', 'Project Rules')
      + codexMessage('user', 'Wait for the second turn before summarizing')
      + codexMessage('assistant', 'Both turns must finish parsing first');
    const { sqlite, env, serverEnv } = await rig(text, 2048, { agent: 'codex' });
    sqlite.run('UPDATE sessions SET ended_at = ?, titling_requested_at = ?', [NOW, NOW]);
    const titledEnv = { ...serverEnv, origin: 'https://deployment.example' };
    expect(await titleReadySessions(titledEnv, NOW + SESSION_END_SETTLE_MS)).toBe(0);
    await drain(env, sqlite);
    expect(target(sqlite)).toEqual({ parsed_offset: Buffer.byteLength(text), size: Buffer.byteLength(text), parse_error: null, fidelity: 'no_tool_results' });
    expect(await titleReadySessions(titledEnv, NOW + SESSION_END_SETTLE_MS + 1)).toBe(1);
    expect((await sessionMaterial(serverEnv.db, PROJECT, SESSION)).map((row) => row.prompt)).toEqual([
      'Read the project rules heading', 'Wait for the second turn before summarizing',
    ]);
    expect((await listUnprocessedPrompts(serverEnv.db, { projectId: PROJECT })).rows).toHaveLength(2);
    expect(await titleReadySessions(titledEnv, NOW + SESSION_END_SETTLE_MS + 2)).toBe(0);
    expect(count(sqlite, 'agent_runs')).toBe(1);
    expect(target(sqlite).fidelity).toBe('no_tool_results');
  });

  it('persists interactive user text and classified context without a developer response', async () => {
    const text = line({ type: 'session_meta', payload: { source: 'cli' } })
      + codexMessage('developer', 'Injected developer instructions')
      + codexMessage('user', '# AGENTS.md instructions for /repo\nRules')
      + codexMessage('user', '<skills_instructions>Use project skills</skills_instructions>')
      + codexMessage('user', 'Editor context\n## My request for Codex:\nFix capture')
      + codexMessage('assistant', 'Capture fixed');
    const { sqlite, env } = await rig(text, 2048, { agent: 'codex' });
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBeNull();
    expect(sqlite.query('SELECT text, origin FROM prompt_batches ORDER BY text').all()).toEqual([
      { text: '<skills_instructions>Use project skills</skills_instructions>', origin: 'system' },
      { text: 'Fix capture', origin: 'user' },
    ]);
    expect(sqlite.query('SELECT text FROM responses').all()).toEqual([{ text: 'Capture fixed' }]);
  });

  it.each(['exec', { subagent: { thread_spawn: { parent_thread_id: 'parent' } } }])('retains the source rule across Codex read windows: %j', async (source) => {
    const header = line({ type: 'session_meta', payload: { source } });
    const text = header + Array.from({ length: 40 }, (_, i) => codexMessage('user', `request ${i} ${'x'.repeat(600)}`)).join('');
    const { sqlite, env } = await rig(text, 2048, { agent: 'codex' });
    expect(await drain(env, sqlite)).toBeGreaterThan(1);
    expect(target(sqlite).parsed_offset).toBe(Buffer.byteLength(text));
    expect(count(sqlite, 'prompt_batches')).toBe(0);
    expect(JSON.parse((sqlite.query('SELECT parser_context FROM transcripts').get() as { parser_context: string }).parser_context).mycoParserMeta).toEqual({ source });
  });

  it('recovers a header before continuing an existing cursor without rewriting prior rows', async () => {
    const header = line({ type: 'session_meta', payload: { source: 'exec' } });
    const prior = codexMessage('user', 'already parsed');
    const text = header + prior + codexMessage('user', 'new exec request');
    const { sqlite, serverEnv } = await rig(text, 2048, { agent: 'codex' });
    const cursor = Buffer.byteLength(header + prior);
    sqlite.run('UPDATE transcripts SET parsed_offset = ?, parser_version = ?', [cursor, PARSER_VERSION]);
    await parseTranscripts(serverEnv, NOW);
    expect(target(sqlite).parsed_offset).toBe(cursor);
    expect(count(sqlite, 'events')).toBe(0);
    await parseTranscripts(serverEnv, NOW);
    expect(target(sqlite).parsed_offset).toBe(Buffer.byteLength(text));
    expect(count(sqlite, 'prompt_batches')).toBe(0);
    expect((await listTranscripts(serverEnv.db, { projectId: PROJECT }, SESSION))[0]).not.toHaveProperty('parserContext');
  });

  it('clears an older parse failure on successful progress so later windows remain eligible', async () => {
    const { sqlite, serverEnv } = await rig(body(100), 2048);
    sqlite.run("UPDATE transcripts SET parse_error = 'parse', parse_failed_at = 1, parser_version = 1");
    await parseTranscripts(serverEnv, NOW, { budget: { calls: PASS_CALLS, wallMs: 60_000 } });
    expect(target(sqlite).parse_error).toBeNull();
    expect(target(sqlite).parsed_offset).toBeGreaterThan(0);
    expect(target(sqlite).parsed_offset).toBeLessThan(target(sqlite).size);
    await drain(serverEnv, sqlite);
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(count(sqlite, 'prompt_batches')).toBe(100);
  });

  it('stores the custom tool call and array output in the recorded Codex rollout', async () => {
    const text = fs.readFileSync(path.join(FIXTURES, 'codex-0.153.4-redacted.jsonl'), 'utf8');
    const { sqlite, env } = await rig(text, 1 << 20, { agent: 'codex' });
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBeNull();
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(sqlite.query('SELECT tool_name, input, output_preview, success FROM tool_calls').all()).toEqual([
      { tool_name: 'exec', input: JSON.stringify('[redacted input]'), output_preview: '[redacted text]\n\n[redacted text]', success: 1 },
    ]);
  });

  it('derives the rows the transcript holds and advances the cursor to its end', async () => {
    const { sqlite, env } = await rig(body(2));
    await drain(env, sqlite);
    expect(count(sqlite, 'prompt_batches')).toBe(2);
    expect(count(sqlite, 'responses')).toBe(2);
    expect(count(sqlite, 'tool_calls')).toBe(2);
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
  });

  it('stamps the fidelity its parser declares, so a reader can tell what the file could support', async () => {
    const { sqlite, env } = await rig(body(1));
    await drain(env, sqlite);
    expect(target(sqlite).fidelity).toBe('full');
    const [row] = await listTranscripts(env.db as never, { projectId: PROJECT }, SESSION);
    expect(row.fidelity).toBe('full');
    expect(row.parsedOffset).toBe(row.size);
  });

  it('spends a bounded number of store calls per pass whatever the transcript holds', async () => {
    const { sqlite, env } = await rig(body(40));
    const t = sqlite.query(`SELECT * FROM transcripts`).get() as Record<string, unknown>;
    const report = await parseOnce(env as never, {
      projectId: PROJECT, transcriptId: TRANSCRIPT, sessionId: SESSION, machineId: MACHINE,
      tokenId: t.token_id as string, agent: 'claude-code', size: t.size as number, parsedOffset: 0, fidelity: null, openPromptId: null, imported: false,
    }, NOW, LIMITS);
    expect(report.calls).toBeLessThanOrEqual(PASS_CALLS + 2);
    expect(report.derived).toBeGreaterThan(TRANSCRIPT_PARSE_EVENTS_PER_BATCH);
  });

  /** One prompt and many tool calls: an agentic turn with no second prompt to stop at. */
  function singleTurn(calls: number): string {
    let out = line({ type: 'user', promptId: uuid(1), message: { content: 'do a lot' }, timestamp: '2026-09-01T10:00:00Z' });
    for (let i = 0; i < calls; i += 1) {
      out += line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `s${i}`, name: 'Read', input: { i } }] }, timestamp: '2026-09-01T10:00:01Z' });
      out += line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `s${i}`, content: 'ok' }] }, timestamp: '2026-09-01T10:00:02Z' });
    }
    return out;
  }

  it('holds the call bound on a window with no prompt to stop at, which a turn-only boundary could not', async () => {
    const { sqlite, env } = await rig(singleTurn(600));
    const t = sqlite.query(`SELECT * FROM transcripts`).get() as Record<string, unknown>;
    const report = await parseOnce(env as never, {
      projectId: PROJECT, transcriptId: TRANSCRIPT, sessionId: SESSION, machineId: MACHINE,
      tokenId: t.token_id as string, agent: 'claude-code', size: t.size as number, parsedOffset: 0, fidelity: null, openPromptId: null, imported: false,
    }, NOW, LIMITS);
    expect(report.calls).toBeLessThanOrEqual(PASS_CALLS + 2);
  });

  it('finishes a single agentic turn across passes, attributing every call to the one prompt', async () => {
    const { sqlite, env } = await rig(singleTurn(600));
    await drain(env, sqlite, 400);
    expect(target(sqlite).parse_error).toBeNull();
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(count(sqlite, 'tool_calls')).toBe(600);
    // The prompt opening the turn is carried across every pass, so no call is
    // orphaned by the boundary a budget happened to fall on.
    const orphans = sqlite.query(`SELECT COUNT(*) c FROM tool_calls WHERE prompt_id IS NULL`).get() as { c: number };
    expect(orphans.c).toBe(0);
  });

  it('carries the turn across a window that ended on its READ bound, not only on the call budget', async () => {
    // Small segments, so a pass ends on the window's own bound rather than on
    // the call budget. The member slices at 8 MiB and a pass takes the first
    // segment whole, so in production every slice boundary falling mid-turn
    // takes this path — and the default 1 MiB rig never does.
    const { sqlite, env } = await rig(singleTurn(30), 96);
    await drain(env, sqlite, 400);
    expect(target(sqlite).parse_error).toBeNull();
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(count(sqlite, 'tool_calls')).toBe(30);
    const orphans = sqlite.query(`SELECT COUNT(*) c FROM tool_calls WHERE prompt_id IS NULL`).get() as { c: number };
    expect(orphans.c).toBe(0);
  });

  it('retains the turn at the current upload boundary for later appended bytes', async () => {
    const { sqlite, env } = await rig(singleTurn(30), 96);
    const t = sqlite.query(`SELECT * FROM transcripts`).get() as Record<string, unknown>;
    await parseOnce(env as never, {
      projectId: PROJECT, transcriptId: TRANSCRIPT, sessionId: SESSION, machineId: MACHINE,
      tokenId: t.token_id as string, agent: 'claude-code', size: t.size as number, parsedOffset: 0, fidelity: null, openPromptId: null, imported: false,
    }, NOW, LIMITS);
    const mid = sqlite.query(`SELECT parsed_offset, size, open_prompt_id FROM transcripts`).get() as { parsed_offset: number; size: number; open_prompt_id: string | null };
    expect(mid.parsed_offset).toBeLessThan(mid.size);
    expect(mid.open_prompt_id).not.toBeNull();

    await drain(env, sqlite, 400);
    const done = sqlite.query(`SELECT parsed_offset, size, open_prompt_id FROM transcripts`).get() as { parsed_offset: number; size: number; open_prompt_id: string | null };
    expect(done.parsed_offset).toBe(done.size);
    expect(done.open_prompt_id).toBe(mid.open_prompt_id);
  });

  it('reaches the same rows whether the bytes arrived as one segment or as many', async () => {
    const text = body(6);
    const whole = await rig(text);
    await drain(whole.env, whole.sqlite);

    // 64-byte segments cut records apart at arbitrary bytes; a record spanning
    // several of them must still derive exactly once.
    const split = await rig(text, 64);
    await drain(split.env, split.sqlite);

    // Many small segments cost one read each; a pass that spent its whole
    // budget fetching them and landed nothing would never move the cursor.
    expect(count(split.sqlite, 'transcript_segments')).toBeGreaterThan(10);
    expect(target(split.sqlite).parsed_offset).toBe(target(split.sqlite).size);
    for (const table of ['prompt_batches', 'responses', 'tool_calls']) {
      expect({ table, split: count(split.sqlite, table) }).toEqual({ table, split: count(whole.sqlite, table) });
    }
  });

  it('lands every tool call of one assistant message, which one id per byte offset could not', async () => {
    const parallel = fs.readFileSync(path.join(FIXTURES, 'claude-parse-parallel.jsonl'), 'utf8');
    const { sqlite, env } = await rig(parallel);
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBeNull();
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(count(sqlite, 'tool_calls')).toBe(2);
    expect(count(sqlite, 'plans')).toBe(2);
    const names = (sqlite.query(`SELECT input FROM tool_calls ORDER BY input`).all() as { input: string }[]).map((r) => r.input);
    expect(names).toEqual(['{"file_path":"/repo/a.ts"}', '{"file_path":"/repo/b.ts"}']);
  });

  it('reads a transcript in as few round trips as its events allow: the selection carries the segments, and the last batch carries the cursor', async () => {
    const { sqlite, serverEnv } = await rig(body(40));
    let trips = 0;
    const alone: string[] = [];
    const counted = (statement: PreparedStatement, sql: string): PreparedStatement => ({
      ...statement,
      bind: (...values: unknown[]) => counted(statement.bind(...values), sql),
      run: () => { trips += 1; alone.push(sql); return statement.run(); },
      all: <T,>() => { trips += 1; alone.push(sql); return statement.all<T>(); },
      first: <T,>() => { trips += 1; alone.push(sql); return statement.first<T>(); },
    });
    let batches = 0;
    const db: RelationalStore = {
      prepare: (sql: string) => counted(serverEnv.db.prepare(sql), sql),
      batch: (statements: PreparedStatement[]) => { trips += 1; batches += 1; return serverEnv.db.batch(statements); },
    };
    await parseTranscripts({ ...serverEnv, db }, NOW + TRANSCRIPT_IDLE_MS, { budget: { calls: 100, wallMs: 60_000 } });
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    const events = count(sqlite, 'events');
    // No read of the segments apart from the selection, and no advance of the cursor apart from the batch that wrote.
    expect(alone.filter((sql) => /FROM transcript_segments s/.test(sql) && !/FROM transcripts/.test(sql))).toEqual([]);
    expect(alone.filter((sql) => /UPDATE transcripts SET parse_segment_lines/.test(sql))).toEqual([]);
    // The open final reply lands in its own terminal batch after the byte-reading pass.
    expect(batches).toBe(Math.ceil((events - 1) / TRANSCRIPT_PARSE_EVENTS_PER_BATCH) + 1);
    // The terminal wake adds one selection to the bounded continuation reads and empty half-scans.
    expect(trips).toBe(batches + 7);
  });

  it('keeps the cursor advance under the hosted parameter ceiling when it rides a batch of the most events one may hold', async () => {
    // Two closing prompts flush the final replies while leaving the last batch at exactly its event limit.
    const text = body(TRANSCRIPT_PARSE_EVENTS_PER_BATCH - 1)
      + line({ type: 'user', promptId: uuid(1000), message: { content: 'next' } })
      + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } })
      + line({ type: 'user', promptId: uuid(1001), message: { content: 'finish' } });
    const { sqlite, serverEnv } = await rig(text);
    const advances: number[] = [];
    const observed = (statement: PreparedStatement, sql: string): PreparedStatement => ({
      ...statement,
      bind: (...values: unknown[]) => {
        if (/UPDATE transcripts SET parse_segment_lines/.test(sql)) advances.push(values.length);
        return statement.bind(...values);
      },
    });
    const db: RelationalStore = { prepare: (sql: string) => observed(serverEnv.db.prepare(sql), sql), batch: (statements) => serverEnv.db.batch(statements) };
    await parseTranscripts({ ...serverEnv, db }, NOW, { budget: { calls: 100, wallMs: 60_000 } });
    expect(count(sqlite, 'events') % TRANSCRIPT_PARSE_EVENTS_PER_BATCH).toBe(0);
    // The one advance carries a guard on a full batch of event ids, and the store binds it: the cursor reaches the end.
    expect(advances).toHaveLength(1);
    expect(advances[0]).toBeGreaterThan(TRANSCRIPT_PARSE_EVENTS_PER_BATCH);
    expect(advances[0]).toBeLessThanOrEqual(D1_BOUND_PARAMETER_CEILING);
    expect(target(sqlite)).toMatchObject({ parsed_offset: target(sqlite).size, parse_error: null });
  });

  it('stops the cursor where an event failed to land rather than advancing past it', async () => {
    const { sqlite, env } = await rig(body(2));
    // An archived Project refuses every write, so no derived event lands. The
    // cursor stays where it stood and the transcript records the failure.
    sqlite.run(`UPDATE projects SET archived_at = ? WHERE project_id = ?`, [NOW, PROJECT]);
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBe('parse');
    expect(target(sqlite).parsed_offset).toBe(0);
    expect(count(sqlite, 'prompt_batches')).toBe(0);
  });

  it('treats a row it already derived as landed, so a wider earlier window does not stop the transcript', async () => {
    const { sqlite, env } = await rig(body(2));
    await drain(env, sqlite);
    const rows = count(sqlite, 'prompt_batches') + count(sqlite, 'tool_calls');
    // Re-reading from zero re-derives every row under the same identity; each
    // is already stored, and none of that is a failure.
    sqlite.run(`UPDATE transcripts SET parsed_offset = 0`);
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBeNull();
    expect(count(sqlite, 'prompt_batches') + count(sqlite, 'tool_calls')).toBe(rows);
  });

  it('resumes across passes when one transcript holds more events than a pass may land', async () => {
    const { sqlite, env } = await rig(body(300));
    const passes = await drain(env, sqlite);
    expect(passes).toBeGreaterThan(1);
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(count(sqlite, 'prompt_batches')).toBe(300);
    expect(count(sqlite, 'responses')).toBe(300);
    expect(count(sqlite, 'tool_calls')).toBe(300);
  });

  it('resumes against the turn it stopped in, not whatever prompt is newest in the session', async () => {
    // A single turn, so every tool call belongs to the one prompt that opened
    // it, and the pass must stop inside that turn.
    const { sqlite, env, tokenId } = await rig(singleTurn(600));
    const t = sqlite.query(`SELECT * FROM transcripts`).get() as Record<string, unknown>;
    const first = await parseOnce(env as never, {
      projectId: PROJECT, transcriptId: TRANSCRIPT, sessionId: SESSION, machineId: MACHINE,
      tokenId: t.token_id as string, agent: 'claude-code', size: t.size as number, parsedOffset: 0, fidelity: null, openPromptId: null, imported: false,
    }, NOW, LIMITS);
    expect(first.nextOffset).toBeGreaterThan(0);
    expect(first.nextOffset).toBeLessThan(t.size as number);

    // The turn the pass stopped inside is recorded, not inferred.
    const carried = (sqlite.query(`SELECT open_prompt_id FROM transcripts`).get() as { open_prompt_id: string | null }).open_prompt_id;
    expect(carried).not.toBeNull();

    // A hook ships a NEWER prompt for the same session while the parse lags —
    // a second agent on the machine, or a subagent sibling. A lookup for the
    // session's newest prompt would take this one and attribute the resumed
    // tail to it.
    sqlite.run(`INSERT INTO prompt_batches (project_id, prompt_id, session_id, event_id, origin, text, content_hash, created_at, updated_at, token_id, received_at)
                VALUES (?, ?, ?, 'hook-event', 'user', 'a later prompt', 'h', ?, ?, ?, ?)`,
               [PROJECT, uuid(999), SESSION, NOW + 10_000, NOW + 10_000, tokenId, NOW + 10_000]);

    await drain(env, sqlite, 400);
    expect(target(sqlite).parse_error).toBeNull();
    expect(count(sqlite, 'tool_calls')).toBe(600);
    const wrong = sqlite.query(`SELECT COUNT(*) c FROM tool_calls WHERE prompt_id IS NOT ?`).get(carried) as { c: number };
    expect(wrong.c).toBe(0);
  });

  it('replaces the carried turn when a new human prompt arrives', async () => {
    const { sqlite, env } = await rig(body(2));
    await drain(env, sqlite);
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    const row = sqlite.query(`SELECT open_prompt_id FROM transcripts`).get() as { open_prompt_id: string | null };
    expect(sqlite.query('SELECT text FROM prompt_batches WHERE prompt_id = ?').get(row.open_prompt_id)).toEqual({ text: 'prompt 1' });
  });

  it('re-derives a resumed turn identically, so no row is refused as a conflict against itself', async () => {
    // A pass that stopped mid-turn would begin the next one without the prompt
    // that turn carries, deriving the same rows with a different payload; each
    // would then be refused against the row already written and the transcript
    // would stop. Every event of a resumed transcript must land.
    const { sqlite, env } = await rig(body(300));
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBeNull();
    const orphans = sqlite.query(`SELECT COUNT(*) c FROM tool_calls WHERE prompt_id IS NULL`).get() as { c: number };
    expect(orphans.c).toBe(0);
    const responses = sqlite.query(`SELECT COUNT(*) c FROM responses WHERE prompt_id IS NULL`).get() as { c: number };
    expect(responses.c).toBe(0);
  });

  it('is idempotent: re-running a completed parse from zero changes no row', async () => {
    const { sqlite, env } = await rig(body(3));
    await drain(env, sqlite);
    const before = count(sqlite, 'prompt_batches') + count(sqlite, 'responses') + count(sqlite, 'tool_calls');
    sqlite.run(`UPDATE transcripts SET parsed_offset = 0`);
    await drain(env, sqlite);
    expect(count(sqlite, 'prompt_batches') + count(sqlite, 'responses') + count(sqlite, 'tool_calls')).toBe(before);
  });

  it('skips an unreadable line rather than abandoning every row the rest of the file holds', async () => {
    // The junk sits between two turns, so the rows either side of it prove the
    // pass carried on rather than stopping at the bad line.
    const two = body(2).split('\n');
    const withJunk = [...two.slice(0, 3), 'not json at all', ...two.slice(3)].join('\n');
    const { sqlite, env } = await rig(withJunk);
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBeNull();
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(count(sqlite, 'prompt_batches')).toBe(2);
  });

  it('stops the transcript once unreadable lines pass the threshold: past it the file is not this format', async () => {
    const junk = Array.from({ length: TRANSCRIPT_PARSE_MALFORMED_LIMIT + 1 }, () => 'not json at all\n').join('');
    const { sqlite, env } = await rig(body(1) + junk);
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBe('parse');
  });

  it('offers a stopped transcript again once the parser moves, so no line silences a file forever', async () => {
    const junk = Array.from({ length: TRANSCRIPT_PARSE_MALFORMED_LIMIT + 1 }, () => 'not json\n').join('');
    const { sqlite, serverEnv } = await rig(body(1) + junk);
    await parseTranscripts(serverEnv, NOW);
    expect(target(sqlite).parse_error).toBe('parse');
    // A failure is recorded against the parser that hit it; a later parser is
    // offered the transcript again rather than inheriting its silence.
    expect(await pendingCount(serverEnv.db)).toBe(0);
    sqlite.run(`UPDATE transcripts SET parser_version = parser_version - 1`);
    expect(await pendingCount(serverEnv.db)).toBe(1);
  });

  it('stops when the store no longer holds a segment, rather than reading past the hole', async () => {
    const { sqlite, env, serverEnv } = await rig(body(2));
    const key = (sqlite.query(`SELECT blob_key FROM transcript_segments`).get() as { blob_key: string }).blob_key;
    await serverEnv.blobs.delete(registeredObject(sqlite, PROJECT, key)!);
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBe('blob_absent');
  });

  it('offers a transcript no parser reads no further, without failing it', async () => {
    const { sqlite, env } = await rig(body(1), 1 << 20, { agent: 'windsurf' });
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBeNull();
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
    expect(count(sqlite, 'prompt_batches')).toBe(0);
  });

  it('skips a transcript belonging to a deleted session', async () => {
    const { sqlite, env, serverEnv } = await rig(body(1));
    sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES (?, ?, NULL, ?, 'm')`, [PROJECT, SESSION, NOW]);
    expect((await parseTranscripts(serverEnv, NOW)).changed).toBe(0);
    expect(count(sqlite, 'prompt_batches')).toBe(0);
    void env;
  });

  it('reports unread bytes so a Deployment with a backlog stays awake', async () => {
    const { sqlite, env } = await rig(body(1));
    expect(await pendingCount(env.db as never)).toBe(1);
    await drain(env, sqlite);
    expect(await pendingCount(env.db as never)).toBe(0);
  });
});

describe('both jobs on a Deployment holding no transcripts', () => {
  /**
   * A tick runs these jobs everywhere, including on a Deployment that has never
   * received a transcript. Reporting anything but zero there would mean the job
   * had found work in an empty store, and every scenario that pins a wake's
   * report would move whenever an unrelated lane added a job.
   */
  /** A recent receipt, so the tick resolves to a depth that runs these jobs at all. */
  const awake = async () => {
    const { sqlite, serverEnv } = sqliteEnv();
    const issued = await issueMemberToken(serverEnv.db, { memberId: 'mem_machine_1', machineId: MACHINE }, NOW);
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
                VALUES (?, 'awake', ?, ?, ?, ?)`, [PROJECT, MACHINE, issued.tokenId, NOW - 60_000, NOW - 60_000]);
    return { sqlite, serverEnv };
  };

  it('reports no work and derives nothing, so a wake elsewhere reads the same as before', async () => {
    const { sqlite, serverEnv } = await awake();
    const report = await runTick(serverEnv, NOW);
    const mine = report.jobs.filter((j) => j.name.startsWith('transcript-'));
    expect(mine).toEqual([
      { name: 'transcript-parse', changed: 0, failed: null, more: false },
      { name: 'transcript-retention', changed: 0, failed: null, more: false },
    ]);
    expect(count(sqlite, 'prompt_batches')).toBe(0);
  });

  it('leaves the power state alone: no unread bytes asserts nothing about depth', async () => {
    const { serverEnv } = await awake();
    const report = await runTick(serverEnv, NOW);
    expect(report.heldBy).not.toBe('transcript:pending');
  });
});

describe('fidelity decides what extraction may read', () => {
  /** A session whose transcript the parser read at reduced fidelity. */
  async function degraded() {
    const { sqlite, env } = await rig(body(1), 1 << 20, { agent: 'cursor' });
    await drain(env, sqlite);
    return { sqlite, env };
  }

  it('stamps the fidelity the format supports rather than the file', async () => {
    const { sqlite } = await degraded();
    expect(target(sqlite).fidelity).toBe('no_tool_results');
  });

  it('omits the session from listSessions with NO filter argument, which is what extraction reads', async () => {
    const { sqlite, env } = await degraded();
    void sqlite;
    expect((await listSessions(env.db as never, { projectId: PROJECT })).rows).toEqual([]);
  });

  it('shows the session to a person or an agent browsing history, labelled', async () => {
    const { env } = await degraded();
    const page = await listSessionSummaries(env.db as never, { projectId: PROJECT }, {}, NOW);
    expect(page.rows.map((r) => r.sessionId)).toEqual([SESSION]);
  });

  it('admits a full-fidelity session to both reads', async () => {
    const { sqlite, env } = await rig(body(1));
    await drain(env, sqlite);
    expect((await listSessions(env.db as never, { projectId: PROJECT })).rows).toHaveLength(1);
    expect((await listSessionSummaries(env.db as never, { projectId: PROJECT }, {}, NOW)).rows).toHaveLength(1);
  });

  it('lets either caller override the default in either direction', async () => {
    const { env } = await degraded();
    expect((await listSessions(env.db as never, { projectId: PROJECT }, { fidelity: 'any' })).rows).toHaveLength(1);
    expect((await listSessionSummaries(env.db as never, { projectId: PROJECT }, { fidelity: 'full' }, NOW)).rows).toEqual([]);
  });

  it('disqualifies a session whose PRIMARY transcript is full but whose subagent sibling is not', async () => {
    const { sqlite, env, tokenId } = await rig(body(1));
    await drain(env, sqlite);
    sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, role, fidelity, size, segment_count, parsed_offset, first_received_at, last_received_at, token_id)
                VALUES (?, 'tx_sibling', ?, ?, 'cursor', 'subagent', 'no_tool_results', 0, 0, 0, ?, ?, ?)`,
               [PROJECT, SESSION, MACHINE, NOW, NOW, tokenId]);
    expect((await listSessions(env.db as never, { projectId: PROJECT })).rows).toEqual([]);
  });
});

describe('transcript retention', () => {
  it('reads a window, treats absent and zero as indefinite, and refuses anything unreadable', () => {
    expect(transcriptRetentionDays(undefined)).toBeNull();
    expect(transcriptRetentionDays('0')).toBeNull();
    expect(transcriptRetentionDays('30')).toBe(30);
    for (const bad of ['"30"', 'null', '-1', '1.5', '4000', 'not json']) {
      expect({ bad, read: transcriptRetentionDays(bad) }).toEqual({ bad, read: 'unreadable' });
    }
  });

  it('prunes nothing when no window is set', async () => {
    const { sqlite, env, serverEnv } = await rig(body(2));
    await drain(env, sqlite);
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
    expect(count(sqlite, 'transcript_segments')).toBeGreaterThan(0);
  });

  it('keeps processed raw bytes forever while no window is set, and with 90 days set prunes only those older than 90 days, keeping every derived row (#1416)', async () => {
    const { sqlite, env, serverEnv } = await rig(body(2));
    await drain(env, sqlite);
    const segments = count(sqlite, 'transcript_segments');
    const derived = count(sqlite, 'prompt_batches');
    expect(segments).toBeGreaterThan(0);
    // Unset: a year-old segment the parse has read stays.
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, [NOW - 365 * 86_400_000]);
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
    expect(count(sqlite, 'transcript_segments')).toBe(segments);

    await settingsWriter(serverEnv.db).setLeaf('retention.transcripts', 90, 'mem_machine_1', NOW);
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, [NOW - 89 * 86_400_000]);
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
    expect(count(sqlite, 'transcript_segments')).toBe(segments);

    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, [NOW - 91 * 86_400_000]);
    expect(await transcriptRetention(serverEnv, NOW)).toBeGreaterThan(0);
    expect(count(sqlite, 'transcript_segments')).toBe(0);
    expect(count(sqlite, 'prompt_batches')).toBe(derived);
    expect(count(sqlite, 'transcripts')).toBe(1);
  });

  it('prunes nothing and says so when the window is unreadable, rather than pruning on a rule nobody wrote', async () => {
    const { sqlite, env, serverEnv } = await rig(body(2));
    await drain(env, sqlite);
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '"thirty"', ?, 'm')`, [NOW]);
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
    expect(count(sqlite, 'transcript_segments')).toBeGreaterThan(0);
  });

  it('prunes segments past the window that the parse has already read, and keeps every derived row', async () => {
    const { sqlite, env, serverEnv } = await rig(body(2));
    await drain(env, sqlite);
    const derived = count(sqlite, 'prompt_batches');
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '1', ?, 'm')`, [NOW]);
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, [NOW - 5 * 86_400_000]);

    expect(await transcriptRetention(serverEnv, NOW)).toBeGreaterThan(0);
    expect(count(sqlite, 'transcript_segments')).toBe(0);
    expect(count(sqlite, 'prompt_batches')).toBe(derived);
    expect(count(sqlite, 'transcripts')).toBe(1);
  });

  it('keeps a segment the parse has not read, whatever its age', async () => {
    const { sqlite, serverEnv } = await rig(body(2));
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '1', ?, 'm')`, [NOW]);
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, [NOW - 5 * 86_400_000]);
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
    expect(count(sqlite, 'transcript_segments')).toBeGreaterThan(0);
  });

  it('never deletes a segment whose blob it has not accounted for, so nothing is left unreachable', async () => {
    // Many small segments, each its own blob: more than one pass can free.
    const { sqlite, serverEnv, env } = await rig(body(20), 96);
    await drain(env, sqlite);
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '1', ?, 'm')`, [NOW]);
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, [NOW - 5 * 86_400_000]);
    const before = count(sqlite, 'transcript_segments');

    await transcriptRetention(serverEnv, NOW);
    // A segment gone is a blob accounted for: what remains in `blobs` is either
    // still referenced or still has its segment.
    const stranded = sqlite.query(`SELECT COUNT(*) c FROM blobs b WHERE NOT (${blobHeld('b.project_id', 'b.key')})`).get() as { c: number };
    expect(stranded.c).toBe(0);
    expect(count(sqlite, 'transcript_segments')).toBeLessThan(before);
  });

  it('drains a large backlog across ticks rather than in one', async () => {
    const { sqlite, serverEnv, env } = await rig(body(20), 96);
    await drain(env, sqlite);
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '1', ?, 'm')`, [NOW]);
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, [NOW - 5 * 86_400_000]);
    let ticks = 0;
    while (count(sqlite, 'transcript_segments') > 0 && ticks < 200) { await transcriptRetention(serverEnv, NOW); ticks += 1; }
    expect(ticks).toBeGreaterThan(1);
    expect(count(sqlite, 'transcript_segments')).toBe(0);
    expect(count(sqlite, 'blobs')).toBe(0);
  });

  it('collects a blob a deletion left behind, which nothing else can reach', async () => {
    const { sqlite, serverEnv } = await rig(body(1));
    // A blob no row names: what a deletion leaves once its page fills.
    registerBlob(sqlite, { projectId: PROJECT, key: 'f'.repeat(64), size: 1, receivedAt: NOW });
    expect(await freeOrphanedBlobs(serverEnv, NOW)).toBe(1);
    expect((sqlite.query(`SELECT COUNT(*) c FROM blobs WHERE key = ?`).get('f'.repeat(64)) as { c: number }).c).toBe(0);
  });

  /** A deletion, which is the only thing that leaves a blob behind. */
  const deleted = (sqlite: Database, at = NOW) =>
    sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES (?, 'gone', NULL, ?, 'm')`, [PROJECT, at]);

  it('collects orphans whether or not a retention window is set', async () => {
    const { sqlite, serverEnv } = await rig(body(1));
    registerBlob(sqlite, { projectId: PROJECT, key: 'e'.repeat(64), size: 1, receivedAt: NOW });
    deleted(sqlite);
    // No window: raw segments are kept forever, and bytes nothing references
    // are still not kept.
    expect(await transcriptRetention(serverEnv, NOW)).toBe(1);
    expect(count(sqlite, 'transcript_segments')).toBeGreaterThan(0);
  });

  it('does not go looking for orphans on a Deployment where nothing was deleted', async () => {
    const { sqlite, serverEnv } = await rig(body(1));
    registerBlob(sqlite, { projectId: PROJECT, key: 'd'.repeat(64), size: 1, receivedAt: NOW });
    // The steady state: the scan is the expensive half and nothing could have
    // made an orphan, so it is not run and the row stands until one is.
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
    expect((sqlite.query(`SELECT COUNT(*) c FROM blobs WHERE key = ?`).get('d'.repeat(64)) as { c: number }).c).toBe(1);
  });

  it('stops looking once a deletion is old enough to have drained', async () => {
    const { sqlite, serverEnv } = await rig(body(1));
    registerBlob(sqlite, { projectId: PROJECT, key: 'c'.repeat(64), size: 1, receivedAt: NOW });
    deleted(sqlite, NOW - TOMBSTONE_SWEEP_GRACE_MS - 1);
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
  });

  it('leaves a blob a surviving row still names', async () => {
    const { sqlite, serverEnv, env } = await rig(body(1));
    await drain(env, sqlite);
    const before = count(sqlite, 'blobs');
    expect(await freeOrphanedBlobs(serverEnv, NOW)).toBe(0);
    expect(count(sqlite, 'blobs')).toBe(before);
  });

  /** Where each blob a test stored its bytes, by Project and key; the name outlives the row that registered it. */
  const placed = new Map<string, string>();
  /** A blob's bytes as the reader would get them, or null when the store no longer holds the object. */
  const readText = async (blobs: { get(key: string): Promise<{ body: ReadableStream } | null> }, projectId: string, key: string): Promise<string | null> => {
    const object = await blobs.get(placed.get(`${projectId}/${key}`)!);
    return object === null ? null : new Response(object.body).text();
  };
  /** A blob row and its object under `projectId`, holding `text`. */
  const stored = async (sqlite: Database, blobs: { put(key: string, body: ReadableStream): Promise<unknown> }, projectId: string, key: string, text: string) => {
    const objectKey = registerBlob(sqlite, { projectId, key, size: text.length, receivedAt: NOW });
    placed.set(`${projectId}/${key}`, objectKey);
    await blobs.put(objectKey, new Blob([text]).stream());
  };
  const toolCall = (sqlite: Database, projectId: string, id: string, input: string | null, output: string | null) =>
    sqlite.run(`INSERT INTO tool_calls (project_id, tool_call_id, session_id, event_id, tool_name, input_blob_key, output_blob_key, success, created_at, token_id, received_at)
                VALUES (?, ?, 's-tools', ?, 'Read', ?, ?, 1, ?, 't', ?)`, [projectId, id, `e-${id}`, input, output, NOW, NOW]);

  it('keeps a tool call\'s spilled input and output, and a compaction summary, through the orphan sweep', async () => {
    const { sqlite, serverEnv } = await rig(body(1));
    const [input, output, summary] = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)];
    await stored(sqlite, serverEnv.blobs, PROJECT, input, 'tool input');
    await stored(sqlite, serverEnv.blobs, PROJECT, output, 'tool output');
    await stored(sqlite, serverEnv.blobs, PROJECT, summary, 'compaction summary');
    toolCall(sqlite, PROJECT, 'tc-1', input, output);
    sqlite.run(`INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at, blob_key)
                VALUES (?, 'e-cmp', 's-tools', 't', 'compaction.post', 'cli', '{}', 'h', ?, ?, ?)`, [PROJECT, NOW, NOW, summary]);
    deleted(sqlite);

    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
    expect(await freeOrphanedBlobs(serverEnv, NOW)).toBe(0);
    expect(await readText(serverEnv.blobs, PROJECT, input)).toBe('tool input');
    expect(await readText(serverEnv.blobs, PROJECT, output)).toBe('tool output');
    expect(await readText(serverEnv.blobs, PROJECT, summary)).toBe('compaction summary');
    expect(sqlite.query(`SELECT input_blob_key, output_blob_key FROM tool_calls`).get()).toEqual({ input_blob_key: input, output_blob_key: output });
  });

  it('frees a key in the Project where nothing holds it, and keeps the same key where a tool call does', async () => {
    const { sqlite, serverEnv } = await rig(body(1));
    const key = '4'.repeat(64);
    await stored(sqlite, serverEnv.blobs, PROJECT, key, 'shared content');
    await stored(sqlite, serverEnv.blobs, 'proj_2', key, 'shared content');
    toolCall(sqlite, PROJECT, 'tc-2', key, null);
    deleted(sqlite);

    expect(await transcriptRetention(serverEnv, NOW)).toBe(1);
    await drainObjectReleases(serverEnv, NOW);
    expect(await readText(serverEnv.blobs, PROJECT, key)).toBe('shared content');
    expect(await readText(serverEnv.blobs, 'proj_2', key)).toBeNull();
    expect(sqlite.query(`SELECT project_id FROM blobs WHERE key = ?`).all(key)).toEqual([{ project_id: PROJECT }]);
  });

  it('prunes a segment whose blob a tool call shares, and keeps the bytes', async () => {
    const { sqlite, serverEnv, env } = await rig(body(1));
    await drain(env, sqlite);
    const { blob_key: key } = sqlite.query(`SELECT blob_key FROM transcript_segments`).get() as { blob_key: string };
    toolCall(sqlite, PROJECT, 'tc-3', null, key);
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '1', ?, 'm')`, [NOW]);
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, [NOW - 5 * 86_400_000]);

    expect(await transcriptRetention(serverEnv, NOW)).toBe(1);
    await drainObjectReleases(serverEnv, NOW);
    expect(count(sqlite, 'transcript_segments')).toBe(0);
    const object = await serverEnv.blobs.get(registeredObject(sqlite, PROJECT, key)!);
    expect(object === null ? null : await new Response(object.body).text()).toBe(body(1));
    expect(count(sqlite, 'blobs')).toBe(1);
  });

  it('is idempotent: a second run finds nothing left to prune', async () => {
    const { sqlite, env, serverEnv } = await rig(body(2));
    await drain(env, sqlite);
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '1', ?, 'm')`, [NOW]);
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, [NOW - 5 * 86_400_000]);
    await transcriptRetention(serverEnv, NOW);
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
  });
});

/** A second transcript in the rig's store, received at `receivedAt`, split into one segment. */
async function addTranscript(
  sqlite: Database, serverEnv: ReturnType<typeof sqliteEnv>['serverEnv'], tokenId: string,
  opts: { transcriptId: string; sessionId: string; agent: string; text: string; receivedAt: number },
): Promise<void> {
  sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [PROJECT, opts.sessionId, MACHINE, tokenId, opts.receivedAt, opts.receivedAt]);
  sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id)
              VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`, [PROJECT, opts.transcriptId, opts.sessionId, MACHINE, opts.agent, opts.receivedAt, opts.receivedAt, tokenId]);
  await appendSegment(sqlite, serverEnv, tokenId, opts.transcriptId, opts.text, opts.receivedAt);
}

/** Bytes arriving for a transcript, as the segment projection records them. */
async function appendSegment(sqlite: Database, serverEnv: ReturnType<typeof sqliteEnv>['serverEnv'], tokenId: string, transcriptId: string, text: string, receivedAt: number): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  const { size } = sqlite.query('SELECT size FROM transcripts WHERE transcript_id = ?').get(transcriptId) as { size: number };
  const key = await sha256HexOf(bytes);
  const objectKey = registerBlob(sqlite, { projectId: PROJECT, key, size: bytes.length, tokenId, receivedAt });
  await serverEnv.blobs.put(objectKey, new Blob([bytes]).stream());
  sqlite.run(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [PROJECT, transcriptId, size, bytes.length, key, `e-${transcriptId}-${size}`, receivedAt, receivedAt, tokenId]);
  sqlite.run('UPDATE transcripts SET size = size + ?, segment_count = segment_count + 1, last_received_at = ? WHERE transcript_id = ?', [bytes.length, receivedAt, transcriptId]);
}


/**
 * Reading a stored transcript again (#1461). A transcript read by a parser that
 * derived nothing from it stands fully read with no rows; its bytes are kept,
 * and reading it again under a parser that knows its format gives the session
 * its prompts.
 */
/** A Cursor transcript of `turns` turns: every line undated, so each is dated by its place in its segment. */
function cursorTurns(turns: number): string {
  let out = '';
  for (let i = 0; i < turns; i += 1) {
    out += line({ role: 'user', message: { content: [{ type: 'text', text: `<user_query>\nquestion ${i}\n</user_query>` }] } });
    out += line({ role: 'assistant', message: { content: [{ type: 'text', text: `looking ${i}` }, { type: 'tool_use', name: 'Shell', input: { command: `echo ${i}` } }] } });
    out += line({ role: 'assistant', message: { content: [{ type: 'text', text: `answer ${i}` }] } });
    out += line({ type: 'turn_ended', status: 'success' });
  }
  return out;
}

describe('a pass under the platform\'s budget (transcript parse throughput)', () => {
  const dated = (sqlite: Database) => sqlite.query('SELECT event_id, kind, created_at FROM events ORDER BY event_id').all();

  it('reads on from the cursor with a ranged read, and dates every undated line exactly as one whole read does', async () => {
    const text = cursorTurns(60);
    // Sent an hour before the pass, so every line's place in its segment shows in its date rather than being held at `now`.
    const sentAt = (r: { sqlite: Database }) => r.sqlite.run('UPDATE transcript_segments SET created_at = ?', [NOW - 3_600_000]);
    const whole = await rig(text, 1 << 20, { agent: 'cursor' });
    sentAt(whole);
    await parseTranscripts(whole.serverEnv, NOW, { budget: { calls: 10_000, wallMs: 60_000 } });
    expect(target(whole.sqlite).parsed_offset).toBe(target(whole.sqlite).size);
    const dates = (whole.sqlite.query('SELECT created_at FROM events').all() as { created_at: number }[]).map((r) => r.created_at);
    expect(new Set(dates).size).toBeGreaterThan(100);

    const inPasses = await rig(text, 1 << 20, { agent: 'cursor' });
    sentAt(inPasses);
    const bucket = inPasses.serverEnv.blobs as unknown as MemoryBlobStore;
    for (let pass = 0; pass < 200 && target(inPasses.sqlite).parsed_offset < target(inPasses.sqlite).size; pass += 1) {
      await parseTranscripts(inPasses.serverEnv, NOW, { budget: { calls: 4, wallMs: 60_000 } });
    }
    expect(target(inPasses.sqlite)).toMatchObject({ parse_error: null, parsed_offset: target(inPasses.sqlite).size });
    // Some pass read its one segment from the cursor rather than from its first byte.
    expect(bucket.gets.some((g) => g.offset > 0)).toBe(true);
    expect(dated(inPasses.sqlite)).toEqual(dated(whole.sqlite));
  });

  it('reads the whole segment where the lines behind the cursor are not counted, and counts them from there', async () => {
    const text = cursorTurns(40);
    const { sqlite, serverEnv } = await rig(text, 1 << 20, { agent: 'cursor' });
    const bucket = serverEnv.blobs as unknown as MemoryBlobStore;
    await parseTranscripts(serverEnv, NOW, { budget: { calls: 4, wallMs: 60_000 } });
    const stood = target(sqlite).parsed_offset;
    expect(stood).toBeGreaterThan(0);
    expect(stood).toBeLessThan(target(sqlite).size);
    sqlite.run('UPDATE transcripts SET parse_segment_lines = NULL');
    bucket.gets.length = 0;
    await parseTranscripts(serverEnv, NOW, { budget: { calls: 4, wallMs: 60_000 } });
    expect(bucket.gets.map((g) => g.offset)).toEqual([0]);
    expect((sqlite.query('SELECT parse_segment_lines AS n FROM transcripts').get() as { n: number | null }).n).not.toBeNull();
  });

  it('spends no more store and blob calls than its budget, beyond the one group a pass always lands', async () => {
    const { serverEnv } = await rig(cursorTurns(1_000), 1 << 20, { agent: 'cursor' });
    // Every store and blob call the pass makes, counted where it is made: one per read, write, batch and blob read.
    let calls = 0;
    let inBatch = false;
    type Statement = { first: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown; bind: (...a: unknown[]) => Statement };
    const counting = (statement: Statement): Statement => {
      for (const method of ['first', 'all', 'run'] as const) {
        const call = statement[method].bind(statement);
        statement[method] = (...args: unknown[]) => { if (!inBatch) calls += 1; return call(...args); };
      }
      const bind = statement.bind.bind(statement);
      statement.bind = (...args: unknown[]) => counting(bind(...args));
      return statement;
    };
    const db = serverEnv.db as unknown as { prepare: (sql: string) => Statement; batch: (s: unknown[]) => Promise<unknown> };
    const prepare = db.prepare.bind(db);
    const batch = db.batch.bind(db);
    db.prepare = (sql: string) => counting(prepare(sql));
    db.batch = async (statements: unknown[]) => { calls += 1; inBatch = true; try { return await batch(statements); } finally { inBatch = false; } };
    const get = serverEnv.blobs.get.bind(serverEnv.blobs);
    serverEnv.blobs.get = (...args: Parameters<typeof get>) => { calls += 1; return get(...args); };
    const outcome = await parseTranscripts(serverEnv, NOW, { budget: { calls: 30, wallMs: 60_000 } });
    expect(outcome.more).toBe(true);
    // The last pass may land the group it started before it counts past the budget, and ends with its own advance.
    expect(calls).toBeLessThanOrEqual(30 + 4);
    expect(calls).toBeGreaterThan(20);
  });

  it('starts no pass past its wall time, and says work remains', async () => {
    const { sqlite, serverEnv } = await rig(cursorTurns(1_000), 1 << 20, { agent: 'cursor' });
    let t = 0;
    const clock = () => (t += 1_000);
    const outcome = await parseTranscripts(serverEnv, NOW, { budget: { calls: 10_000, wallMs: 5_000 }, clock });
    expect(outcome.more).toBe(true);
    expect(target(sqlite).parsed_offset).toBeLessThan(target(sqlite).size);
    expect(t).toBeLessThan(20_000);
  });

  it('takes the platform\'s declared budget when a run names none, and reads far past the fixed cap it replaced', async () => {
    const { sqlite, serverEnv } = await rig(cursorTurns(200), 1 << 20, { agent: 'cursor' });
    expect(serverEnv.platform.jobBudget.calls).toBeGreaterThanOrEqual(500);
    const outcome = await parseTranscripts(serverEnv, NOW);
    expect({ parsed: target(sqlite).parsed_offset === target(sqlite).size, more: outcome.more }).toEqual({ parsed: true, more: false });
  });

  it('counts what is waiting in bytes left to read, and never a deleted session\'s transcript', async () => {
    const { sqlite, serverEnv } = await rig(cursorTurns(10), 1 << 20, { agent: 'cursor' });
    const size = target(sqlite).size;
    expect(await pendingTranscripts(serverEnv.db)).toEqual({ transcripts: 1, bytes: size, imported: { transcripts: 0, bytes: 0 } });
    sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES (?, ?, NULL, ?, 'm')`, [PROJECT, SESSION, NOW]);
    expect(await pendingTranscripts(serverEnv.db)).toEqual({ transcripts: 0, bytes: 0, imported: { transcripts: 0, bytes: 0 } });
  });

  it('stops at a record too long to hold with a named reason, and says so to the tick', async () => {
    const text = line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(TRANSCRIPT_PARSE_RECORD_BYTES) }] } });
    const { sqlite, serverEnv } = await rig(text, TRANSCRIPT_PARSE_RECORD_BYTES / 2, { agent: 'codex' });
    const outcome = await parseTranscripts(serverEnv, NOW, { budget: { calls: 50, wallMs: 60_000 } });
    expect({ error: target(sqlite).parse_error, more: outcome.more }).toEqual({ error: 'record_too_large', more: false });
  });
});

describe('ranged reads across segment boundaries (transcript parse throughput)', () => {
  const dated = (sqlite: Database) => sqlite.query('SELECT event_id, created_at FROM events ORDER BY event_id').all() as { event_id: string; created_at: number }[];
  // Each segment sent a millisecond per byte of offset earlier, so a line's segment shows in its date as well as its place.
  const sentAt = (r: { sqlite: Database }) => r.sqlite.run('UPDATE transcript_segments SET created_at = ? - base_offset', [NOW - 3_600_000]);
  for (const slice of [2048, 3001, 777, 1 << 20]) {
    it(`dates every row read in small passes over segments of ${slice} bytes as one whole read dates it`, async () => {
      const text = cursorTurns(80);
      const whole = await rig(text, slice, { agent: 'cursor' });
      sentAt(whole);
      for (let pass = 0; pass < 500 && target(whole.sqlite).parsed_offset < target(whole.sqlite).size; pass += 1) {
        await parseTranscripts(whole.serverEnv, NOW, { budget: { calls: 10_000, wallMs: 60_000 } });
      }
      const inPasses = await rig(text, slice, { agent: 'cursor' });
      sentAt(inPasses);
      const bucket = inPasses.serverEnv.blobs as unknown as MemoryBlobStore;
      for (let pass = 0; pass < 2000 && target(inPasses.sqlite).parsed_offset < target(inPasses.sqlite).size; pass += 1) {
        await parseTranscripts(inPasses.serverEnv, NOW, { budget: { calls: 3, wallMs: 60_000 } });
      }
      expect(target(inPasses.sqlite)).toMatchObject({ parse_error: null, parsed_offset: target(inPasses.sqlite).size });
      expect(bucket.gets.some((g) => g.offset > 0)).toBe(true);
      const w = new Map(dated(whole.sqlite).map((r) => [r.event_id, r.created_at]));
      const p = dated(inPasses.sqlite);
      expect(p.length).toBeGreaterThan(150);
      expect(p.filter((r) => w.has(r.event_id) && w.get(r.event_id) !== r.created_at)).toEqual([]);
    });
  }

  it('keeps the count and the open turn of a further cursor when a slower pass beside it lands behind it', async () => {
    const text = cursorTurns(40);
    const { sqlite, serverEnv } = await rig(text, 1 << 20, { agent: 'cursor' });
    sentAt({ sqlite });
    const row = () => sqlite.query('SELECT parsed_offset, parse_segment_lines, open_prompt_id FROM transcripts').get() as { parsed_offset: number; parse_segment_lines: number | null; open_prompt_id: string | null };
    const t = sqlite.query('SELECT token_id, size FROM transcripts').get() as { token_id: string; size: number };
    // Both passes took the transcript at its first byte: an owner's wake beside the clock's.
    const stale = {
      projectId: PROJECT, transcriptId: TRANSCRIPT, sessionId: SESSION, machineId: MACHINE, tokenId: t.token_id, agent: 'cursor',
      size: t.size, parsedOffset: 0, fidelity: null, openPromptId: null, imported: false, segmentLines: 0,
    };
    const env = { db: serverEnv.db, blobs: serverEnv.blobs };
    await parseOnce(env as never, stale, NOW, { calls: 8, deadline: Number.POSITIVE_INFINITY, clock: () => 0 });
    const further = row();
    await parseOnce(env as never, stale, NOW, { calls: 4, deadline: Number.POSITIVE_INFINITY, clock: () => 0 });
    // The slower pass stopped behind the further cursor: it moves nothing, and names no count or turn of its own there.
    const after = row();
    expect(after.parsed_offset).toBe(further.parsed_offset);
    expect({ lines: after.parse_segment_lines === null || after.parse_segment_lines === further.parse_segment_lines, turn: after.open_prompt_id })
      .toEqual({ lines: true, turn: further.open_prompt_id });

    // Read on to the end, every row is dated as one whole read dates it.
    for (let pass = 0; pass < 200 && target(sqlite).parsed_offset < target(sqlite).size; pass += 1) {
      await parseTranscripts(serverEnv, NOW, { budget: { calls: 3, wallMs: 60_000 } });
    }
    const whole = await rig(text, 1 << 20, { agent: 'cursor' });
    sentAt(whole);
    await parseTranscripts(whole.serverEnv, NOW, { budget: { calls: 10_000, wallMs: 60_000 } });
    const w = new Map(dated(whole.sqlite).map((r) => [r.event_id, r.created_at]));
    expect(dated(sqlite).filter((r) => w.get(r.event_id) !== r.created_at)).toEqual([]);
  });
});

describe('reading a stored transcript again', () => {
  const cursorBytes = () => fs.readFileSync(path.join(FIXTURES, 'cursor-agent-2026.09-redacted.jsonl'), 'utf8');
  const rowCounts = (sqlite: Database) => Object.fromEntries(['events', 'prompt_batches', 'responses', 'tool_calls'].map((t) => [t, count(sqlite, t)]));

  it('gives a Cursor session read before the fix its prompt and its reply', async () => {
    const { sqlite, serverEnv } = await rig(cursorBytes(), 1 << 20, { agent: 'cursor' });
    // What the old parser left behind: every byte read, nothing derived.
    sqlite.run('UPDATE transcripts SET parsed_offset = size, parsed_at = ?, parser_version = ?', [NOW, PARSER_VERSION]);
    expect(await pendingCount(serverEnv.db)).toBe(0);

    expect(await rereadTranscripts(serverEnv.db, { agent: 'cursor' })).toBe(1);
    expect(await pendingCount(serverEnv.db)).toBe(1);
    await parseTranscripts(serverEnv, NOW);

    expect(sqlite.query('SELECT text FROM prompt_batches').all()).toEqual([
      { text: 'List the files in this directory and say how many there are. Do not modify anything.' },
    ]);
    expect((sqlite.query('SELECT text FROM responses ORDER BY created_at, response_id').all() as { text: string }[]).map((row) => row.text).join('\n\n')).toContain('Nothing was modified.');
    expect(target(sqlite)).toMatchObject({ parse_error: null, parsed_offset: target(sqlite).size });
  });

  it('lands no second copy of any row when a transcript already read is read again', async () => {
    const { sqlite, serverEnv } = await rig(body(3));
    await parseTranscripts(serverEnv, NOW);
    const before = rowCounts(sqlite);
    expect(before.prompt_batches).toBe(3);

    expect(await rereadTranscripts(serverEnv.db, { projectId: PROJECT, sessionId: SESSION })).toBe(1);
    for (let pass = 0; pass < 10 && (await pendingCount(serverEnv.db)) > 0; pass += 1) await parseTranscripts(serverEnv, NOW);

    expect(rowCounts(sqlite)).toEqual(before);
    expect(target(sqlite)).toMatchObject({ parse_error: null, parsed_offset: target(sqlite).size });
  });

  it('rereads joined legacy replies across windows and retries without duplicating their text', async () => {
    const replies = ['first reply ' + 'a'.repeat(120_000) + ' ', ' second reply ' + 'b'.repeat(120_000) + ' ', ' third reply'];
    const prefix = line({ type: 'user', promptId: uuid(70), message: { content: 'legacy prompt' } });
    const firstOffset = new TextEncoder().encode(prefix).length;
    const spacer = line({ type: 'system', text: 's'.repeat(400_000) });
    const text = prefix + line({ type: 'assistant', message: { content: [{ type: 'text', text: replies[0] }] } }) + spacer
      + replies.slice(1).map((reply) => line({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } })).join('')
      + line({ type: 'user', promptId: uuid(72), message: { content: 'later turn' } });
    const later = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'later appended reply' }] } });
    const { sqlite, serverEnv, tokenId } = await rig(text + later, 300_000);
    // A stored joined reply uses the identity of its first assistant record.
    const first = (await PARSERS['claude-code'].parse({ lines: [{ value: JSON.parse(text.split('\n')[1]), offset: firstOffset }], sessionId: SESSION, now: NOW }))[0];
    const oldText = replies.join('\n\n');
    expect((await ingestEvent(serverEnv.db, { projectId: PROJECT, machineId: MACHINE, tokenId, now: NOW, bodyBytes: 0, writeOrigin: 'server' }, {
      eventId: await uuidv5('transcript-event', TRANSCRIPT, 'response', String(first.payload.responseId)), sessionId: SESSION, kind: 'response', createdAt: NOW, channel: 'cli', producer: TRANSCRIPT_PRODUCER,
      payload: { ...first.payload, promptId: uuid(70), text: oldText },
    })).persisted).toBe(true);
    sqlite.run('UPDATE transcripts SET parsed_offset = ?, parser_version = 3', [Buffer.byteLength(text)]);
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await rereadTranscripts(serverEnv.db, { projectId: PROJECT, sessionId: SESSION });
      await drain({ db: serverEnv.db, blobs: serverEnv.blobs }, sqlite);
      expect(sqlite.query('SELECT text FROM responses ORDER BY rowid').all()).toEqual([{ text: oldText }, { text: 'later appended reply' }]);
      expect(target(sqlite)).toMatchObject({ parse_error: null, parsed_offset: target(sqlite).size });
    }
  });

  it('preserves Codex header metadata when rereading after its header segment was retained away', async () => {
    const header = line({ type: 'session_meta', payload: { source: 'cli', marker: 'retained-header-context' } });
    const user = line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'human question' }] } });
    const reply = line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } });
    const { sqlite, serverEnv, env } = await rig(header + user + reply, Buffer.byteLength(header), { agent: 'codex' });
    const context = () => JSON.parse((sqlite.query('SELECT parser_context FROM transcripts').get() as { parser_context: string }).parser_context);
    await drain(env, sqlite);
    expect(context()).toMatchObject({ source: 'cli', marker: 'retained-header-context' });
    const before = rowCounts(sqlite);
    sqlite.run('DELETE FROM transcript_segments WHERE base_offset = 0');
    await rereadTranscripts(serverEnv.db, { projectId: PROJECT, sessionId: SESSION });
    await drain(env, sqlite);
    expect(context()).toMatchObject({ source: 'cli', marker: 'retained-header-context',
      mycoParserMeta: { source: 'cli', marker: 'retained-header-context' } });
    expect(rowCounts(sqlite)).toEqual(before);
    expect(target(sqlite).parse_error).toBeNull();
  });

  it('clears a recorded failure, so a transcript a parser stopped on is read again under the fixed one', async () => {
    const { sqlite, serverEnv } = await rig(cursorBytes(), 1 << 20, { agent: 'cursor' });
    sqlite.run("UPDATE transcripts SET parse_error = 'parse', parse_failed_at = 1, parser_version = ?", [PARSER_VERSION]);
    expect(await pendingCount(serverEnv.db)).toBe(0);
    await rereadTranscripts(serverEnv.db, { agent: 'cursor' });
    await parseTranscripts(serverEnv, NOW);
    expect(count(sqlite, 'prompt_batches')).toBe(1);
  });

  const cursorTurns = (turns: number) => Array.from({ length: turns }, (_, i) =>
    `${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `<user_query>\nq${i + 1}\n</user_query>` }] } })}\n`
    + `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: `a${i + 1}` }] } })}\n`).join('');
  const texts = (sqlite: Database, table: 'prompt_batches' | 'responses') => (sqlite.query(`SELECT text FROM ${table} ORDER BY created_at, text`).all() as Array<{ text: string }>).map((r) => r.text);

  it('reads again from the first segment retention left, landing no row twice', async () => {
    const text = cursorTurns(4);
    const pair = Buffer.byteLength(cursorTurns(1));
    // One segment per turn, and one cut across lines: both must name every row at its own offset.
    for (const slice of [pair, 100]) {
      const { sqlite, serverEnv } = await rig(text, slice, { agent: 'cursor' });
      for (let pass = 0; pass < 20 && (await pendingCount(serverEnv.db)) > 0; pass += 1) await parseTranscripts(serverEnv, NOW + TRANSCRIPT_IDLE_MS);
      expect({ slice, prompts: texts(sqlite, 'prompt_batches') }).toEqual({ slice, prompts: ['q1', 'q2', 'q3', 'q4'] });
      // Retention prunes read segments oldest first.
      const firstKept = slice === pair ? pair * 2 : 300;
      sqlite.run('DELETE FROM transcript_segments WHERE base_offset < ?', [firstKept]);
      const heldFrom = (sqlite.query('SELECT MIN(base_offset) AS b FROM transcript_segments').get() as { b: number }).b;

      expect(await rereadTranscripts(serverEnv.db, { projectId: PROJECT, sessionId: SESSION })).toBe(1);
      expect(target(sqlite).parsed_offset).toBe(heldFrom);
      for (let pass = 0; pass < 20 && (await pendingCount(serverEnv.db, NOW + TRANSCRIPT_IDLE_MS + 1000)) > 0; pass += 1)
        await parseTranscripts(serverEnv, NOW + TRANSCRIPT_IDLE_MS + 1000);
      expect({ slice, prompts: texts(sqlite, 'prompt_batches'), responses: texts(sqlite, 'responses') })
        .toEqual({ slice, prompts: ['q1', 'q2', 'q3', 'q4'], responses: ['a1', 'a2', 'a3', 'a4'] });
      expect(target(sqlite)).toMatchObject({ parsed_offset: Buffer.byteLength(text), parse_error: null });
    }
  });

  it('leaves a transcript that holds no segment where it stands, and it reads the segments that arrive after', async () => {
    const { sqlite, serverEnv, tokenId } = await rig(cursorTurns(2), 1 << 20, { agent: 'cursor' });
    await parseTranscripts(serverEnv, NOW);
    sqlite.run('DELETE FROM transcript_segments');
    expect(await rereadTranscripts(serverEnv.db, { agent: 'cursor' })).toBe(0);
    await parseTranscripts(serverEnv, NOW + 1000);
    expect(target(sqlite)).toMatchObject({ parsed_offset: target(sqlite).size, parse_error: null });

    await appendSegment(sqlite, serverEnv, tokenId, TRANSCRIPT, cursorTurns(3).slice(Buffer.byteLength(cursorTurns(2))), NOW + 2000);
    expect(await pendingCount(serverEnv.db)).toBe(1);
    await parseTranscripts(serverEnv, NOW + 3000);
    expect(texts(sqlite, 'prompt_batches')).toEqual(['q1', 'q2', 'q3']);
    expect(target(sqlite)).toMatchObject({ parsed_offset: target(sqlite).size, parse_error: null });
  });

  it('dates a row read again 30 days later at the time its segment was sent, in the order its lines were written', async () => {
    const { sqlite, serverEnv } = await rig(cursorTurns(4), 1 << 20, { agent: 'cursor' });
    sqlite.run('UPDATE transcripts SET parsed_offset = size');
    await rereadTranscripts(serverEnv.db, { agent: 'cursor' });
    await parseTranscripts(serverEnv, NOW + 30 * 86_400_000);
    const prompts = sqlite.query('SELECT text, created_at FROM prompt_batches ORDER BY created_at, prompt_id').all() as Array<{ text: string; created_at: number }>;
    expect(prompts.map((p) => p.text)).toEqual(['q1', 'q2', 'q3', 'q4']);
    // Line positions 0, 2, 4, 6 of the one segment, sent at NOW.
    expect(prompts.map((p) => p.created_at - NOW)).toEqual([0, 2, 4, 6]);
    const responses = sqlite.query('SELECT text, created_at FROM responses ORDER BY created_at, response_id').all() as Array<{ text: string; created_at: number }>;
    expect(responses.map((r) => [r.text, r.created_at - NOW])).toEqual([['a1', 1], ['a2', 3], ['a3', 5], ['a4', 7]]);
  });

  it('dates an undated line from a live segment at its segment\'s time, not at the parse', async () => {
    const { sqlite, serverEnv } = await rig(cursorTurns(1), 1 << 20, { agent: 'cursor' });
    await parseTranscripts(serverEnv, NOW + 30 * 86_400_000);
    expect(sqlite.query('SELECT created_at FROM prompt_batches').all()).toEqual([{ created_at: NOW }]);
  });

  it('rewinds only what the selector names', async () => {
    const { sqlite, serverEnv } = await rig(body(1));
    await parseTranscripts(serverEnv, NOW);
    expect(await rereadTranscripts(serverEnv.db, { agent: 'cursor' })).toBe(0);
    expect(await rereadTranscripts(serverEnv.db, { projectId: PROJECT, sessionId: 'another' })).toBe(0);
    expect(target(sqlite).parsed_offset).toBe(target(sqlite).size);
  });
});

/**
 * One transcript never holds back the rest (#1461). A transcript that cannot
 * move leaves the queue with a recorded state, so the job goes on to the next
 * one and nothing keeps the Deployment awake for it; the bytes that let it
 * move put it back.
 */
describe('a transcript that cannot move yet', () => {
  const cursorLine = (role: string, text: string) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } });
  const promptTexts = (sqlite: Database) => (sqlite.query('SELECT text FROM prompt_batches ORDER BY text').all() as Array<{ text: string }>).map((r) => r.text);

  it('reads a Cursor transcript whose last line has no newline to its end', async () => {
    const text = `${cursorLine('user', '<user_query>\nfirst\n</user_query>')}\n${cursorLine('assistant', 'one')}\n${cursorLine('user', '<user_query>\nsecond\n</user_query>')}\n${cursorLine('assistant', 'two')}`;
    const { sqlite, serverEnv } = await rig(text, 1 << 20, { agent: 'cursor' });
    await parseTranscripts(serverEnv, NOW);
    expect(target(sqlite)).toMatchObject({ parsed_offset: Buffer.byteLength(text), parse_error: null });
    expect(promptTexts(sqlite)).toEqual(['first', 'second']);
    expect(count(sqlite, 'responses')).toBe(1);
    await parseTranscripts(serverEnv, NOW + TRANSCRIPT_IDLE_MS);
    expect(count(sqlite, 'responses')).toBe(2);
  });

  it('reads every parser\'s fixture to the same rows with or without a newline after its last record', async () => {
    const derivedRows = (sqlite: Database) => Object.fromEntries(['prompt_batches', 'responses', 'tool_calls', 'plans'].map((t) => [t, count(sqlite, t)]));
    for (const agent of Object.keys(PARSERS)) {
      const fixture = fs.readFileSync(path.join(FIXTURES, `${agent === 'claude-code' ? 'claude' : agent}-parse-basic.jsonl`), 'utf8');
      expect({ agent, endsWithNewline: fixture.endsWith('\n') }).toEqual({ agent, endsWithNewline: true });
      const ended = await rig(fixture, 1 << 20, { agent });
      await parseTranscripts(ended.serverEnv, NOW);
      const unended = await rig(fixture.trimEnd(), 1 << 20, { agent });
      await parseTranscripts(unended.serverEnv, NOW);
      expect({ agent, rows: derivedRows(unended.sqlite), state: target(unended.sqlite).parse_error })
        .toEqual({ agent, rows: derivedRows(ended.sqlite), state: null });
      expect({ agent, read: target(unended.sqlite).parsed_offset }).toEqual({ agent, read: target(unended.sqlite).size });
    }
  });

  it('never holds back the transcripts behind it, and is read once the bytes that finish it arrive', async () => {
    // The oldest transcript ends in a record still being written; a newer one is complete.
    const unfinished = `${cursorLine('user', '<user_query>\nolder\n</user_query>')}\n${cursorLine('assistant', 'half').slice(0, 20)}`;
    const { sqlite, serverEnv, tokenId } = await rig(unfinished, 1 << 20, { agent: 'cursor' });
    await addTranscript(sqlite, serverEnv, tokenId, {
      transcriptId: 'tx_fedcba9876543210fedcba9876543210', sessionId: 's2', agent: 'cursor', receivedAt: NOW + 1,
      text: `${cursorLine('user', '<user_query>\nnewer\n</user_query>')}\n${cursorLine('assistant', 'done')}\n`,
    });

    await parseTranscripts(serverEnv, NOW + 2);
    await parseTranscripts(serverEnv, NOW + 3);
    expect(promptTexts(sqlite)).toEqual(['newer', 'older']);
    expect(sqlite.query('SELECT parse_error FROM transcripts WHERE transcript_id = ?').get(TRANSCRIPT)).toEqual({ parse_error: AWAITING_BYTES });
    // Waiting keeps nothing awake.
    expect(await pendingCount(serverEnv.db)).toBe(0);

    // The rest of the record arrives, and the transcript is back in the queue and read to its end.
    const rest = cursorLine('assistant', 'half').slice(20);
    await appendSegment(sqlite, serverEnv, tokenId, TRANSCRIPT, rest, NOW + 4);
    expect(await pendingCount(serverEnv.db)).toBe(1);
    await parseTranscripts(serverEnv, NOW + 5);
    expect(target(sqlite)).toMatchObject({ parsed_offset: target(sqlite).size, parse_error: null });
    expect(count(sqlite, 'responses')).toBe(0);
    await parseTranscripts(serverEnv, NOW + TRANSCRIPT_IDLE_MS + 5);
    expect(count(sqlite, 'responses')).toBe(2);
  });

  it('stays queued when bytes land while the pass that found the record unfinished is still running', async () => {
    const whole = cursorLine('assistant', 'written across two segments');
    const { sqlite, serverEnv, tokenId } = await rig(whole.slice(0, 20), 1 << 20, { agent: 'cursor' });
    const blobs = serverEnv.blobs;
    let landedDuringPass = false;
    const racing = { ...serverEnv, blobs: { ...blobs, get: async (key: string) => {
      const read = await blobs.get(key);
      if (!landedDuringPass) { landedDuringPass = true; await appendSegment(sqlite, serverEnv, tokenId, TRANSCRIPT, `${whole.slice(20)}\n`, NOW); }
      return read;
    } } } as typeof serverEnv;
    // The pass that found the record unfinished read the older size; the job takes the transcript again and finishes it.
    await parseTranscripts(racing, NOW);
    expect(landedDuringPass).toBe(true);
    expect(target(sqlite)).toMatchObject({ parsed_offset: target(sqlite).size, parse_error: null });
    expect(count(sqlite, 'responses')).toBe(0);
    await parseTranscripts(serverEnv, NOW + TRANSCRIPT_IDLE_MS);
    expect(count(sqlite, 'responses')).toBe(1);
  });

  it('is put back by the bytes that finish the record whatever their clock says', async () => {
    const whole = cursorLine('assistant', 'finished in the same millisecond');
    const { sqlite, serverEnv, tokenId } = await rig(whole.slice(0, 20), 1 << 20, { agent: 'cursor' });
    await parseTranscripts(serverEnv, NOW);
    expect(await pendingCount(serverEnv.db)).toBe(0);
    // Received at the same instant the wait began, and from a clock behind it.
    await appendSegment(sqlite, serverEnv, tokenId, TRANSCRIPT, `${whole.slice(20)}\n`, NOW - 5_000);
    expect(await pendingCount(serverEnv.db)).toBe(1);
    await parseTranscripts(serverEnv, NOW);
    expect(count(sqlite, 'responses')).toBe(0);
    await parseTranscripts(serverEnv, NOW + TRANSCRIPT_IDLE_MS);
    expect(count(sqlite, 'responses')).toBe(1);
  });

  it('moves a cursor no held segment covers to the first byte still held, and reads on', async () => {
    const turn = (i: number) => `${cursorLine('user', `<user_query>\nq${i}\n</user_query>`)}\n`;
    const text = turn(1) + turn(2) + turn(3);
    const { sqlite, serverEnv, tokenId } = await rig(text, Buffer.byteLength(turn(1)), { agent: 'cursor' });
    sqlite.run('DELETE FROM transcript_segments WHERE base_offset = 0');
    await parseTranscripts(serverEnv, NOW);
    await parseTranscripts(serverEnv, NOW);
    expect(promptTexts(sqlite)).toEqual(['q2', 'q3']);
    expect(target(sqlite)).toMatchObject({ parsed_offset: Buffer.byteLength(text), parse_error: null });
    await appendSegment(sqlite, serverEnv, tokenId, TRANSCRIPT, turn(4), NOW + 1);
    await parseTranscripts(serverEnv, NOW + 2);
    expect(promptTexts(sqlite)).toEqual(['q2', 'q3', 'q4']);
  });

  it('never holds back the transcripts behind it when its own bytes are gone, and moves past what is gone', async () => {
    const { sqlite, serverEnv, tokenId } = await rig(body(1));
    sqlite.run('DELETE FROM transcript_segments WHERE transcript_id = ?', [TRANSCRIPT]);
    await addTranscript(sqlite, serverEnv, tokenId, {
      transcriptId: 'tx_fedcba9876543210fedcba9876543210', sessionId: 's2', agent: 'cursor', receivedAt: NOW + 1,
      text: `${cursorLine('user', '<user_query>\nnewer\n</user_query>')}\n`,
    });
    await parseTranscripts(serverEnv, NOW + 2);
    expect(promptTexts(sqlite)).toEqual(['newer']);
    expect(target(sqlite)).toMatchObject({ parsed_offset: target(sqlite).size, parse_error: null });
  });
});

describe('a turn whose reply is longer than one response holds', () => {
  /** Twelve assistant messages of 25,000 characters: 300,000 in one turn, past the 262,144 a response holds. */
  const replies = Array.from({ length: 12 }, (_, i) => `message ${i} ${(i % 2 === 0 ? 'é plain words ' : 'plain words ').repeat(2_500).slice(0, 25_000)}`);
  const whole = replies.join('\n\n');
  const codex = line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summarize everything' }] } })
    + replies.map((text) => line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })).join('');
  const cursor = line({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nsummarize everything\n</user_query>' }] } })
    + replies.map((text) => line({ role: 'assistant', message: { content: [{ type: 'text', text }] } })).join('')
    + line({ type: 'turn_ended', status: 'success' });
  const responses = (sqlite: Database) => (sqlite.query('SELECT text FROM responses ORDER BY created_at, response_id').all() as Array<{ text: string }>).map((r) => r.text);

  for (const [agent, text] of [['codex', codex], ['cursor', cursor]] as const) {
    it(`${agent}: reads to the end with every part of the reply landed`, async () => {
      expect(whole.length).toBeGreaterThan(262_144);
      const { sqlite, serverEnv } = await rig(text, 1 << 20, { agent });
      for (let pass = 0; pass < 10 && (await pendingCount(serverEnv.db, NOW + TRANSCRIPT_IDLE_MS)) > 0; pass += 1)
        await parseTranscripts(serverEnv, NOW + TRANSCRIPT_IDLE_MS);
      expect(target(sqlite)).toMatchObject({ parse_error: null, parsed_offset: Buffer.byteLength(text) });
      const landed = responses(sqlite);
      expect(landed.length).toBeGreaterThan(1);
      expect(new Set(landed).size).toBe(landed.length);
      expect([...landed].sort((a, b) => whole.indexOf(a) - whole.indexOf(b)).join('\n\n')).toBe(whole);
    });
  }

  it('reads again a transcript the parser before the split stopped on', async () => {
    const { sqlite, serverEnv } = await rig(codex, 1 << 20, { agent: 'codex' });
    // Version 2 stopped the Codex Desktop transcripts whose turns ran past one response.
    sqlite.run("UPDATE transcripts SET parse_error = 'parse', parse_failed_at = 1, parser_version = 2");
    expect(await pendingCount(serverEnv.db)).toBe(1);
    await parseTranscripts(serverEnv, NOW + TRANSCRIPT_IDLE_MS);
    expect(target(sqlite)).toMatchObject({ parse_error: null, parsed_offset: Buffer.byteLength(codex) });
    expect(responses(sqlite).length).toBeGreaterThan(1);
  });

  it('admits an oversized derived prompt and advances instead of stopping capture', async () => {
    const tooLong = line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(300_000) }] } });
    const { sqlite, serverEnv } = await rig(tooLong, 1 << 20, { agent: 'codex' });
    await parseTranscripts(serverEnv, NOW);
    expect(target(sqlite)).toMatchObject({ parse_error: null, parsed_offset: Buffer.byteLength(tooLong) });
    expect((sqlite.query('SELECT text FROM prompt_batches').get() as { text: string }).text).toContain('not kept');
  });
});

describe('the groups a pass writes', () => {
  const event = (offset: number, text: string) => ({ kind: 'response', offset, createdAt: 1, payload: { responseId: uuid(offset + 1), text } });
  const bytes = (group: Array<{ payload: unknown }>) => group.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e.payload)), 0);

  it('writes small events fifty to a call, in order', () => {
    const events = Array.from({ length: 120 }, (_, i) => event(i, `reply ${i}`));
    const groups = eventGroups(events);
    expect(groups.map((g) => g.length)).toEqual([TRANSCRIPT_PARSE_EVENTS_PER_BATCH, TRANSCRIPT_PARSE_EVENTS_PER_BATCH, 20]);
    expect(groups.flat()).toEqual(events);
  });

  it('never carries more payload in one call than twenty of the largest events could, and fills each call it can', () => {
    const events = Array.from({ length: 60 }, (_, i) => event(i, 'x'.repeat(200_000)));
    const groups = eventGroups(events);
    expect(groups.flat()).toEqual(events);
    for (const [n, group] of groups.entries()) {
      expect(bytes(group)).toBeLessThanOrEqual(TRANSCRIPT_PARSE_BATCH_PAYLOAD_BYTES);
      if (n < groups.length - 1) expect(bytes([...group, groups[n + 1][0]])).toBeGreaterThan(TRANSCRIPT_PARSE_BATCH_PAYLOAD_BYTES);
    }
    expect(TRANSCRIPT_PARSE_BATCH_PAYLOAD_BYTES).toBe(20 * 262_144);
  });

  it('writes an event larger than a call alone rather than dropping it', () => {
    const events = [event(0, 'x'.repeat(TRANSCRIPT_PARSE_BATCH_PAYLOAD_BYTES)), event(1, 'small')];
    expect(eventGroups(events).map((g) => g.length)).toEqual([1, 1]);
  });
});


describe('durable parser continuation at the read floor', () => {
  const rows = (sqlite: Database) => Object.fromEntries([
    ['prompt_batches', 'prompt_id, text, origin, prompt_kind, created_at'],
    ['responses', 'response_id, prompt_id, text, created_at'],
    ['tool_calls', 'tool_call_id, prompt_id, tool_name, input, success, output_preview, error_message, created_at'],
    ['plans', 'plan_key, prompt_id, title, content, status, origin_path, source, created_at'],
  ].map(([table, columns]) => [table, sqlite.query(`SELECT ${columns} FROM ${table} ORDER BY created_at, 1`).all()]));

  it('retains successful tool results and both plans across read windows and a serialized restart', async () => {
    const at = '2026-09-01T10:00:00Z';
    const prefix = line({ type: 'user', promptId: uuid(1), message: { content: 'start' }, timestamp: at })
      + line({ type: 'assistant', message: { content: [{ type: 'text', text: '<ultraplan># First plan</ultraplan>' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } }] }, timestamp: at })
      + line({ type: 'file-history-snapshot', padding: 'x'.repeat(TRANSCRIPT_PARSE_BYTES_PER_READ) });
    const suffix = line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, timestamp: at })
      + line({ type: 'assistant', message: { content: [{ type: 'text', text: '<ultraplan># Second plan</ultraplan>' }] }, timestamp: at })
      + line({ type: 'user', promptId: uuid(2), message: { content: 'later' }, timestamp: at });
    const text = prefix + suffix;
    const whole = await rig(text, text.length);
    await drain(whole.env, whole.sqlite);
    const split = await rig(text, Buffer.byteLength(prefix));
    await parseTranscripts(split.serverEnv, NOW, { budget: { calls: 3, wallMs: 60_000 } });
    expect(target(split.sqlite).parsed_offset).toBe(Buffer.byteLength(prefix));
    expect(count(split.sqlite, 'tool_calls')).toBe(0);
    const persisted = split.sqlite.query('SELECT parser_context FROM transcripts').get() as { parser_context: string };
    expect(JSON.parse(persisted.parser_context).mycoParserState.planPosition).toBe(1);
    await drain(split.env, split.sqlite);
    expect(target(split.sqlite)).toMatchObject({ parse_error: null, parsed_offset: Buffer.byteLength(text) });
    expect(rows(split.sqlite)).toEqual(rows(whole.sqlite));
    expect(split.sqlite.query('SELECT success, output_preview FROM tool_calls').all()).toEqual([{ success: 1, output_preview: 'ok' }]);
    expect(count(split.sqlite, 'plans')).toBe(2);
  });

  it('cursor-budget checkpoints retain only the plan ordinal and pending calls before the cursor', async () => {
    const text = Array.from({ length: 70 }, (_, i) => line({ type: 'assistant', timestamp: '2026-09-01T10:00:00Z',
      message: { content: [{ type: 'text', text: `<ultraplan># Plan ${i}</ultraplan>` }] } })).join('');
    const whole = await rig(text);
    await drain(whole.env, whole.sqlite);
    const split = await rig(text);
    for (let pass = 0; pass < 20 && target(split.sqlite).parsed_offset < target(split.sqlite).size; pass += 1)
      await parseTranscripts(split.serverEnv, NOW, { budget: { calls: 3, wallMs: 60_000 } });
    expect(target(split.sqlite).parsed_offset).toBe(Buffer.byteLength(text));
    expect(count(split.sqlite, 'responses')).toBe(0);
    await parseTranscripts(split.serverEnv, NOW + TRANSCRIPT_IDLE_MS);
    expect(rows(split.sqlite)).toEqual(rows(whole.sqlite));
    expect(count(split.sqlite, 'plans')).toBe(70);
  });

  it('an oversized Claude reply followed by a valid turn is admitted and capture completes', async () => {
    for (const oversized of ['a'.repeat(300_000), '😀'.repeat(100_000), '\\"\n'.repeat(100_000)]) {
      const text = line({ type: 'user', promptId: uuid(1), message: { content: 'start' } })
        + line({ type: 'assistant', message: { content: [{ type: 'text', text: oversized }] } })
        + line({ type: 'user', promptId: uuid(2), message: { content: 'later valid turn' } })
        + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'later valid reply' }] } });
      const { sqlite, env } = await rig(text);
      await drain(env, sqlite);
      expect(target(sqlite)).toMatchObject({ parsed_offset: Buffer.byteLength(text), parse_error: null });
      expect(sqlite.query("SELECT text FROM prompt_batches WHERE text = 'later valid turn'").get()).toEqual({ text: 'later valid turn' });
      expect(sqlite.query("SELECT text FROM responses WHERE text = 'later valid reply'").get()).toEqual({ text: 'later valid reply' });
      expect((sqlite.query('SELECT text FROM responses WHERE text <> ?').get('later valid reply') as { text: string }).text).toContain('not kept');
    }
  });
});
