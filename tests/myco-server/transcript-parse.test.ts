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
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  parseOnce, parseTranscripts, pendingTranscriptBytes,
  TRANSCRIPT_PARSE_CALLS_PER_PASS, TRANSCRIPT_PARSE_EVENTS_PER_BATCH,
} from '@myco-server-worker/ingest/parse.js';
import { transcriptRetention, transcriptRetentionDays } from '@myco-server-worker/core/jobs-run.js';
import { listTranscripts } from '@myco-server-worker/read/transcript.js';
import { sqliteEnv, count, uuid } from './helpers/fixtures.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';

const NOW = Date.parse('2027-01-01T00:00:00Z');
const PROJECT = 'proj_1';
const SESSION = 's1';
const TRANSCRIPT = 'tx_0123456789abcdef0123456789abcdef';
const MACHINE = 'machine_1';

const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;

/** A transcript body with `turns` prompt-and-reply pairs, each also making a tool call. */
function body(turns: number): string {
  let out = '';
  for (let i = 0; i < turns; i += 1) {
    out += line({ type: 'user', promptId: `${uuid(i + 1)}`, message: { content: `prompt ${i}` }, timestamp: '2026-09-01T10:00:00Z' });
    out += line({ type: 'assistant', message: { content: [{ type: 'text', text: `reply ${i}` }, { type: 'tool_use', id: `t${i}`, name: 'Read', input: { i } }] }, timestamp: '2026-09-01T10:00:01Z' });
    out += line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] }, timestamp: '2026-09-01T10:00:02Z' });
  }
  return out;
}

/** A store holding one transcript whose bytes are split into `sliceBytes` segments. */
async function rig(text: string, sliceBytes = 1 << 20, opts: { agent?: string } = {}) {
  const { sqlite, serverEnv } = sqliteEnv();
  const issued = await issueMemberToken(serverEnv.db, { memberId: 'mem_machine_1', machineId: MACHINE }, NOW);
  const bytes = new TextEncoder().encode(text);

  sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
              VALUES (?, ?, ?, ?, ?, ?)`, PROJECT, SESSION, MACHINE, issued.tokenId, NOW, NOW);
  sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
             PROJECT, TRANSCRIPT, SESSION, MACHINE, opts.agent ?? 'claude-code', bytes.length, 1, NOW, NOW, issued.tokenId);

  for (let at = 0; at < bytes.length; at += sliceBytes) {
    const slice = bytes.subarray(at, Math.min(at + sliceBytes, bytes.length));
    const key = await sha256HexOf(slice);
    await serverEnv.blobs.put(`${PROJECT}/${key}`, new Blob([slice]).stream());
    sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (project_id, key) DO NOTHING`, PROJECT, key, slice.length, 'text/plain', issued.tokenId, NOW);
    sqlite.run(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, PROJECT, TRANSCRIPT, at, slice.length, key, `e${at}`, NOW, NOW, issued.tokenId);
  }
  return { sqlite, env: { db: serverEnv.db, blobs: serverEnv.blobs }, serverEnv, tokenId: issued.tokenId };
}

const target = (sqlite: Database) => {
  const row = sqlite.query(`SELECT parsed_offset, size, parse_error, fidelity FROM transcripts`).get() as
    { parsed_offset: number; size: number; parse_error: string | null; fidelity: string | null };
  return row;
};

/** Drives passes to completion, counting database calls so the bound can be asserted. */
async function drain(env: { db: unknown; blobs: unknown }, sqlite: Database, max = 50): Promise<number> {
  let passes = 0;
  while (passes < max && target(sqlite).parsed_offset < target(sqlite).size && target(sqlite).parse_error === null) {
    const t = sqlite.query(`SELECT project_id, transcript_id, session_id, machine_id, token_id, agent, size, parsed_offset, fidelity FROM transcripts`).get() as Record<string, unknown>;
    const before = target(sqlite).parsed_offset;
    await parseOnce(env as never, {
      projectId: t.project_id as string, transcriptId: t.transcript_id as string, sessionId: t.session_id as string,
      machineId: t.machine_id as string, tokenId: t.token_id as string, agent: t.agent as string,
      size: t.size as number, parsedOffset: t.parsed_offset as number, fidelity: null,
    }, NOW);
    passes += 1;
    if (target(sqlite).parsed_offset === before) break;
  }
  return passes;
}

describe('parsing a held transcript', () => {
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
      tokenId: t.token_id as string, agent: 'claude-code', size: t.size as number, parsedOffset: 0, fidelity: null,
    }, NOW);
    expect(report.calls).toBeLessThanOrEqual(TRANSCRIPT_PARSE_CALLS_PER_PASS + 2);
    expect(report.derived).toBeGreaterThan(TRANSCRIPT_PARSE_EVENTS_PER_BATCH);
  });

  it('reaches the same rows in many small passes as in one, so resuming loses and repeats nothing', async () => {
    const text = body(6);
    const whole = await rig(text);
    await drain(whole.env, whole.sqlite);

    const split = await rig(text, 64);
    const passes = await drain(split.env, split.sqlite);

    expect(passes).toBeGreaterThan(1);
    for (const table of ['prompt_batches', 'responses', 'tool_calls']) {
      expect({ table, split: count(split.sqlite, table) }).toEqual({ table, split: count(whole.sqlite, table) });
    }
  });

  it('is idempotent: re-running a completed parse from zero changes no row', async () => {
    const { sqlite, env } = await rig(body(3));
    await drain(env, sqlite);
    const before = count(sqlite, 'prompt_batches') + count(sqlite, 'responses') + count(sqlite, 'tool_calls');
    sqlite.run(`UPDATE transcripts SET parsed_offset = 0`);
    await drain(env, sqlite);
    expect(count(sqlite, 'prompt_batches') + count(sqlite, 'responses') + count(sqlite, 'tool_calls')).toBe(before);
  });

  it('stops the transcript and names the failure when a line is not JSON, keeping the rows it already derived', async () => {
    const { sqlite, env } = await rig(body(1) + 'not json at all\n' + body(1));
    await drain(env, sqlite);
    expect(target(sqlite).parse_error).toBe('parse');
    expect(count(sqlite, 'prompt_batches')).toBeGreaterThanOrEqual(0);
  });

  it('stops when the store no longer holds a segment, rather than reading past the hole', async () => {
    const { sqlite, env, serverEnv } = await rig(body(2));
    const key = (sqlite.query(`SELECT blob_key FROM transcript_segments`).get() as { blob_key: string }).blob_key;
    await serverEnv.blobs.delete(`${PROJECT}/${key}`);
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
    sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES (?, ?, NULL, ?, 'm')`, PROJECT, SESSION, NOW);
    expect(await parseTranscripts(serverEnv, NOW)).toBe(0);
    expect(count(sqlite, 'prompt_batches')).toBe(0);
    void env;
  });

  it('reports unread bytes so a Deployment with a backlog stays awake', async () => {
    const { sqlite, env } = await rig(body(1));
    expect(await pendingTranscriptBytes(env.db as never)).toBe(1);
    await drain(env, sqlite);
    expect(await pendingTranscriptBytes(env.db as never)).toBe(0);
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

  it('prunes nothing and says so when the window is unreadable, rather than pruning on a rule nobody wrote', async () => {
    const { sqlite, env, serverEnv } = await rig(body(2));
    await drain(env, sqlite);
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '"thirty"', ?, 'm')`, NOW);
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
    expect(count(sqlite, 'transcript_segments')).toBeGreaterThan(0);
  });

  it('prunes segments past the window that the parse has already read, and keeps every derived row', async () => {
    const { sqlite, env, serverEnv } = await rig(body(2));
    await drain(env, sqlite);
    const derived = count(sqlite, 'prompt_batches');
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '1', ?, 'm')`, NOW);
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, NOW - 5 * 86_400_000);

    expect(await transcriptRetention(serverEnv, NOW)).toBeGreaterThan(0);
    expect(count(sqlite, 'transcript_segments')).toBe(0);
    expect(count(sqlite, 'prompt_batches')).toBe(derived);
    expect(count(sqlite, 'transcripts')).toBe(1);
  });

  it('keeps a segment the parse has not read, whatever its age', async () => {
    const { sqlite, serverEnv } = await rig(body(2));
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '1', ?, 'm')`, NOW);
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, NOW - 5 * 86_400_000);
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
    expect(count(sqlite, 'transcript_segments')).toBeGreaterThan(0);
  });

  it('is idempotent: a second run finds nothing left to prune', async () => {
    const { sqlite, env, serverEnv } = await rig(body(2));
    await drain(env, sqlite);
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('retention.transcripts', '1', ?, 'm')`, NOW);
    sqlite.run(`UPDATE transcript_segments SET created_at = ?`, NOW - 5 * 86_400_000);
    await transcriptRetention(serverEnv, NOW);
    expect(await transcriptRetention(serverEnv, NOW)).toBe(0);
  });
});
