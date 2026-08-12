import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatchStateless } from '@myco/db/queries/batches.js';
import { sha256Hex } from '@myco/capture/diagnostics/hash.js';
import {
  collectSessionRows,
  collectAgentRuns,
  collectLogEntries,
  redactLogPayload,
} from '@myco/capture/diagnostics/collect-vault.js';

const PROSE = 'PLANTED_PROSE_should_not_leak';
const RESPONSE_PROSE = 'PLANTED_RESPONSE_SUMMARY_should_not_leak';

beforeEach(() => {
  setupTestDb();
  cleanTestDb();
});
afterAll(() => teardownTestDb());

/**
 * Seed one in-window session with a batch, plus one out-of-window session,
 * via the real query layer (upsertSession / insertBatchStateless). `title`
 * and `summary` on the 'in' session, and `user_prompt` on the batch, carry
 * the planted prose marker. `StatelessBatchInsert` has no `response_summary`
 * field — `insertBatchStateless` hardcodes it to NULL on insert (it is
 * populated later by a separate transcript-matching pass, batches.ts:431+)
 * — so it is planted via a direct UPDATE on the real single-writer's own
 * column, matching the DDL.
 */
function seedSessionAndBatch(db: Database, prose: string, responseProse: string): void {
  upsertSession({
    id: 'in',
    agent: 'claude-code',
    started_at: 1000,
    created_at: 1000,
    title: prose,
    summary: prose,
  });
  upsertSession({
    id: 'out',
    agent: 'claude-code',
    started_at: 99_999,
    created_at: 99_999,
  });
  const { row } = insertBatchStateless({
    session_id: 'in',
    created_at: 1001,
    started_at: 1001,
    user_prompt: prose,
  });
  db.query(`UPDATE prompt_batches SET response_summary = $rs WHERE id = $id`).run({
    $rs: responseProse,
    $id: row.id,
  });
}

/**
 * Seed one agent_runs row plus one agent_reports and one agent_turns child,
 * via direct INSERTs matching schema-ddl.ts:391-451 (FKs are enforced —
 * `agents` must exist first).
 */
function seedAgentRun(db: Database, prose: string): void {
  db.query(
    `INSERT INTO agents (id, name, source, created_at) VALUES ('agent-1', 'test-agent', 'built-in', 1)`,
  ).run();
  db.query(
    `INSERT INTO agent_runs (id, project_id, agent_id, task, instruction, status, started_at)
     VALUES ('run-1', 'p', 'agent-1', 'test-task', $prose, 'completed', 1200)`,
  ).run({ $prose: prose });
  db.query(
    `INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, created_at)
     VALUES ('p', 'run-1', 'agent-1', 'assess', $prose, 1200)`,
  ).run({ $prose: prose });
  db.query(
    `INSERT INTO agent_turns (project_id, run_id, agent_id, turn_number, tool_name, tool_input, started_at)
     VALUES ('p', 'run-1', 'agent-1', 1, 'test-tool', $prose, 1200)`,
  ).run({ $prose: prose });
}

describe('collectSessionRows', () => {
  test('window-filters, drops prose columns by default, keeps content_hash, emits user_prompt_sha256', () => {
    const db = getDatabase();
    seedSessionAndBatch(db, PROSE, RESPONSE_PROSE);

    const jsonl = collectSessionRows(db, { since: 0, until: 2000 }, false);
    expect(jsonl).not.toContain(PROSE);
    expect(jsonl).not.toContain(RESPONSE_PROSE);
    expect(jsonl).not.toContain('"out"');
    const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l));
    const session = lines.find((l) => l.table === 'sessions' && l.row.id === 'in');
    expect(session.row.content_hash).toBeDefined();
    expect(session.row.title).toBeUndefined();
    const batch = lines.find((l) => l.table === 'prompt_batches');
    expect(batch.row.user_prompt).toBeUndefined();
    expect(batch.row.user_prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(batch.row.response_summary).toBeUndefined();
    expect(batch.row.response_summary_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(batch.row.response_summary_sha256).toBe(sha256Hex(RESPONSE_PROSE));
    expect(batch.row.response_summary_bytes).toBe(Buffer.byteLength(RESPONSE_PROSE, 'utf8'));
  });

  test('includeContent=true keeps prose columns, including response_summary', () => {
    const db = getDatabase();
    seedSessionAndBatch(db, PROSE, RESPONSE_PROSE);
    const jsonl = collectSessionRows(db, { since: 0, until: 2000 }, true);
    expect(jsonl).toContain(PROSE);
    expect(jsonl).toContain(RESPONSE_PROSE);
    const batch = jsonl
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((l) => l.table === 'prompt_batches');
    expect(batch.row.response_summary).toBe(RESPONSE_PROSE);
  });
});

describe('collectAgentRuns', () => {
  test('windows on started_at; prose columns hashed by default', () => {
    const db = getDatabase();
    seedAgentRun(db, PROSE);
    const jsonl = collectAgentRuns(db, { since: 0, until: 2000 }, false);
    expect(jsonl).not.toContain(PROSE);
    const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l));
    const run = lines.find((l) => l.table === 'agent_runs');
    expect(run.row.instruction_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(run.row.instruction).toBeUndefined();
    const report = lines.find((l) => l.table === 'agent_reports');
    expect(report.row.summary_sha256).toMatch(/^[0-9a-f]{64}$/);
    const turn = lines.find((l) => l.table === 'agent_turns');
    expect(turn.row.tool_input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(collectAgentRuns(db, { since: 0, until: 2000 }, true)).toContain(PROSE);
  });

  test('run outside the window is excluded, along with its children', () => {
    const db = getDatabase();
    seedAgentRun(db, PROSE);
    const jsonl = collectAgentRuns(db, { since: 5000, until: 6000 }, false);
    expect(jsonl).toBe('');
  });
});

describe('collectLogEntries', () => {
  test('filters by ISO window; payload data is hashed, never verbatim', () => {
    const db = getDatabase();
    const ins = (ts: number, message: string, data: string | null) =>
      db
        .query(
          `INSERT INTO log_entries (project_id, timestamp, level, component, kind, message, data)
           VALUES ('p', $ts, 'info', 'capture', 'test.kind', $message, $data)`,
        )
        .run({ $ts: new Date(ts * 1000).toISOString(), $message: message, $data: data });
    ins(1500, 'inside', JSON.stringify({ prompt_preview: PROSE }));
    ins(9999, 'outside', null);
    const jsonl = collectLogEntries(db, { since: 0, until: 2000 }, false);
    expect(jsonl).toContain('inside');
    expect(jsonl).not.toContain('outside');
    // the F1 gate: prompt_preview must not survive
    expect(jsonl).not.toContain(PROSE);
    // key names + byte_length + sha256 survive
    expect(jsonl).toContain('payload');
    expect(jsonl).toContain('prompt_preview');
  });

  test('includeContent=true keeps the raw data payload verbatim', () => {
    const db = getDatabase();
    db.query(
      `INSERT INTO log_entries (project_id, timestamp, level, component, kind, message, data)
       VALUES ('p', $ts, 'info', 'capture', 'test.kind', 'inside', $data)`,
    ).run({ $ts: new Date(1500 * 1000).toISOString(), $data: JSON.stringify({ prompt_preview: PROSE }) });
    const jsonl = collectLogEntries(db, { since: 0, until: 2000 }, true);
    expect(jsonl).toContain(PROSE);
  });
});

describe('redactLogPayload', () => {
  test('null data passes through untouched', () => {
    expect(redactLogPayload({ message: 'm', data: null }, false)).toEqual({ message: 'm', data: null });
  });

  test('unparseable data degrades to a single _unparseable hash entry', () => {
    const result = redactLogPayload({ message: 'm', data: 'not json' }, false) as {
      payload: Record<string, { byte_length: number; sha256: string }>;
    };
    expect(result.payload._unparseable.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
