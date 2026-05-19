/**
 * Tests for the per-session Myco tool-call aggregation pattern.
 *
 * Seeds an in-memory vault with sessions + activities, then exercises both
 * the pure aggregator (`aggregateSessionMycoToolCalls`) and the
 * write-side materializer (`materializeSessionMycoToolCalls`).
 *
 * Coverage matrix:
 *   - canonicalization of `mcp__myco__<tool>`           → `<tool>`
 *   - canonicalization of legacy `myco_myco_<tool>`     → `myco_<tool>`
 *   - canonicalization of `mcp__myco__myco_myco_<tool>` → `myco_<tool>`
 *   - MCP-prefixed and bare names collapse into a single canonical bucket
 *     (regression guard against the CTE/GROUP BY shadow bug)
 *   - op dimension extracted from `tool_input.op`, empty string when absent
 *   - non-Myco tool calls ignored
 *   - rows with malformed `tool_input` skipped (no SQL error)
 *   - collective_* tools surface alongside myco_* tools
 *   - materialize is idempotent + delete-then-insert (snapshot stays faithful)
 *   - materialize stamps the session's project_id onto every row
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import {
  aggregateSessionMycoToolCalls,
  materializeSessionMycoToolCalls,
  getSessionMycoToolCallCounts,
} from '@myco/db/queries/myco-tool-usage.js';

const PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROJECT_ROOT = '/repo/myco';
const SESSION_ID = 'sess_test_tool_usage';

interface SeedActivity {
  tool_name: string;
  tool_input?: unknown;
  ts?: number;
}

function seedSession(sessionId: string = SESSION_ID, projectId: string = PROJECT_ID) {
  const now = Math.floor(Date.now() / 1000);
  upsertSession({
    id: sessionId,
    agent: 'claude-code',
    started_at: now,
    created_at: now,
    project_id: projectId,
    project_root: PROJECT_ROOT,
  });
}

function seedActivities(sessionId: string, activities: SeedActivity[]) {
  const db = getDatabase();
  const base = Math.floor(Date.now() / 1000);
  // activities.prompt_batch_id is NOT NULL (v43 invariant) — open a batch.
  const batchInsert = db
    .prepare(
      `INSERT INTO prompt_batches (session_id, prompt_number, started_at, created_at, status)
       VALUES (?, 1, ?, ?, 'active')`,
    )
    .run(sessionId, base, base);
  const batchId = Number(batchInsert.lastInsertRowid);

  const insert = db.prepare(
    `INSERT INTO activities (
       session_id, prompt_batch_id, tool_name, tool_input,
       timestamp, processed, created_at
     ) VALUES (?, ?, ?, ?, ?, 0, ?)`,
  );
  activities.forEach((a, i) => {
    const ts = base + (a.ts ?? i);
    const toolInput =
      a.tool_input === undefined
        ? null
        : typeof a.tool_input === 'string'
          ? a.tool_input
          : JSON.stringify(a.tool_input);
    insert.run(sessionId, batchId, a.tool_name, toolInput, ts, ts);
  });
}

beforeAll(() => {
  setupTestDb();
});

beforeEach(() => {
  cleanTestDb();
});

afterAll(() => {
  teardownTestDb();
});

describe('aggregateSessionMycoToolCalls — canonicalization', () => {
  it('strips the mcp__myco__ prefix', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'mcp__myco__myco_search', tool_input: { query: 'x' } },
      { tool_name: 'mcp__myco__myco_search', tool_input: { query: 'y' } },
    ]);
    const result = aggregateSessionMycoToolCalls(null, SESSION_ID);
    expect(result).toEqual([{ tool_name: 'myco_search', op: '', count: 2 }]);
  });

  it('collapses MCP-prefixed and bare names into one bucket (CTE/GROUP BY regression guard)', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'myco_cortex',              tool_input: { op: 'canopy_map' } },
      { tool_name: 'myco_cortex',              tool_input: { op: 'canopy_map' } },
      { tool_name: 'mcp__myco__myco_cortex',   tool_input: { op: 'canopy_map' } },
    ]);
    const result = aggregateSessionMycoToolCalls(null, SESSION_ID);
    expect(result).toEqual([{ tool_name: 'myco_cortex', op: 'canopy_map', count: 3 }]);
  });

  it('strips the legacy doubled myco_myco_ prefix', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'myco_myco_search', tool_input: { query: 'a' } },
      { tool_name: 'myco_search',      tool_input: { query: 'b' } },
    ]);
    const result = aggregateSessionMycoToolCalls(null, SESSION_ID);
    expect(result).toEqual([{ tool_name: 'myco_search', op: '', count: 2 }]);
  });

  it('strips the combined mcp__myco__myco_myco_ prefix', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'mcp__myco__myco_myco_search', tool_input: { query: 'a' } },
    ]);
    const result = aggregateSessionMycoToolCalls(null, SESSION_ID);
    expect(result).toEqual([{ tool_name: 'myco_search', op: '', count: 1 }]);
  });
});

describe('aggregateSessionMycoToolCalls — op dimension', () => {
  it('extracts op from tool_input.op when present', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'myco_plans', tool_input: { op: 'list' } },
      { tool_name: 'myco_plans', tool_input: { op: 'save', content: 'x' } },
      { tool_name: 'myco_plans', tool_input: { op: 'save', content: 'y' } },
    ]);
    const result = aggregateSessionMycoToolCalls(null, SESSION_ID);
    expect(result.sort((a, b) => a.op.localeCompare(b.op))).toEqual([
      { tool_name: 'myco_plans', op: 'list', count: 1 },
      { tool_name: 'myco_plans', op: 'save', count: 2 },
    ]);
  });

  it('uses empty string op when tool_input has no op field', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'myco_search', tool_input: { query: 'x' } },
    ]);
    const result = aggregateSessionMycoToolCalls(null, SESSION_ID);
    expect(result).toEqual([{ tool_name: 'myco_search', op: '', count: 1 }]);
  });

  it('uses empty string op when tool_input is null', () => {
    seedSession();
    seedActivities(SESSION_ID, [{ tool_name: 'myco_search' }]);
    const result = aggregateSessionMycoToolCalls(null, SESSION_ID);
    expect(result).toEqual([{ tool_name: 'myco_search', op: '', count: 1 }]);
  });
});

describe('aggregateSessionMycoToolCalls — filtering', () => {
  it('ignores non-Myco tool calls (Read, Bash, Edit, etc.)', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'Read',  tool_input: { file_path: '/x' } },
      { tool_name: 'Bash',  tool_input: { command: 'ls' } },
      { tool_name: 'Edit',  tool_input: { file_path: '/y' } },
      { tool_name: 'myco_search', tool_input: { query: 'x' } },
    ]);
    const result = aggregateSessionMycoToolCalls(null, SESSION_ID);
    expect(result).toEqual([{ tool_name: 'myco_search', op: '', count: 1 }]);
  });

  it('surfaces collective_* tools alongside myco_* tools', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'collective_search',           tool_input: { query: 'x' } },
      { tool_name: 'mcp__myco__collective_search', tool_input: { query: 'y' } },
      { tool_name: 'myco_search',                 tool_input: { query: 'z' } },
    ]);
    const result = aggregateSessionMycoToolCalls(null, SESSION_ID).sort((a, b) =>
      a.tool_name.localeCompare(b.tool_name),
    );
    expect(result).toEqual([
      { tool_name: 'collective_search', op: '', count: 2 },
      { tool_name: 'myco_search',       op: '', count: 1 },
    ]);
  });

  it('skips activities with malformed tool_input (does not abort the GROUP BY)', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'myco_search', tool_input: '{not valid json' },
      { tool_name: 'myco_search', tool_input: { query: 'ok' } },
    ]);
    const result = aggregateSessionMycoToolCalls(null, SESSION_ID);
    expect(result).toEqual([{ tool_name: 'myco_search', op: '', count: 1 }]);
  });

  it('returns empty array for a non-existent session', () => {
    expect(aggregateSessionMycoToolCalls(null, 'sess_does_not_exist')).toEqual([]);
  });

  it('returns empty array for a session with no Myco activity', () => {
    seedSession();
    seedActivities(SESSION_ID, [{ tool_name: 'Read', tool_input: { file_path: '/x' } }]);
    expect(aggregateSessionMycoToolCalls(null, SESSION_ID)).toEqual([]);
  });
});

describe('materializeSessionMycoToolCalls — write side', () => {
  it('stamps the session project_id onto every written row', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'myco_search',                 tool_input: { query: 'x' } },
      { tool_name: 'mcp__myco__myco_cortex',      tool_input: { op: 'canopy_map' } },
    ]);
    const written = materializeSessionMycoToolCalls(SESSION_ID);
    expect(written).toBe(2);
    const rows = getDatabase()
      .prepare('SELECT project_id FROM session_myco_tool_calls WHERE session_id = ?')
      .all(SESSION_ID) as Array<{ project_id: string | null }>;
    for (const row of rows) {
      expect(row.project_id).toBe(PROJECT_ID);
    }
  });

  it('is idempotent — row count and contents stay stable across replays', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'myco_search', tool_input: { query: 'x' } },
      { tool_name: 'myco_plans',  tool_input: { op: 'list' } },
      { tool_name: 'myco_plans',  tool_input: { op: 'save', content: 'x' } },
    ]);
    materializeSessionMycoToolCalls(SESSION_ID);
    const first = getSessionMycoToolCallCounts(SESSION_ID);
    materializeSessionMycoToolCalls(SESSION_ID);
    const second = getSessionMycoToolCallCounts(SESSION_ID);
    expect(second).toEqual(first);
  });

  it('updates the snapshot when a new activity lands (delete-then-insert)', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'myco_cortex', tool_input: { op: 'canopy_map' }, ts: 0 },
      { tool_name: 'myco_cortex', tool_input: { op: 'canopy_map' }, ts: 1 },
    ]);
    materializeSessionMycoToolCalls(SESSION_ID);
    expect(getSessionMycoToolCallCounts(SESSION_ID)).toEqual([
      { tool_name: 'myco_cortex', op: 'canopy_map', count: 2 },
    ]);

    // Reuse the open batch so the FK insert succeeds.
    const db = getDatabase();
    const batchId = (db
      .prepare('SELECT id FROM prompt_batches WHERE session_id = ? LIMIT 1')
      .get(SESSION_ID) as { id: number } | undefined)?.id;
    expect(batchId).toBeDefined();
    db.prepare(
      `INSERT INTO activities (session_id, prompt_batch_id, tool_name, tool_input,
                               timestamp, processed, created_at)
       VALUES (?, ?, 'mcp__myco__myco_cortex', '{"op":"canopy_map"}', unixepoch(), 0, unixepoch())`,
    ).run(SESSION_ID, batchId);

    materializeSessionMycoToolCalls(SESSION_ID);
    expect(getSessionMycoToolCallCounts(SESSION_ID)).toEqual([
      { tool_name: 'myco_cortex', op: 'canopy_map', count: 3 },
    ]);
  });

  it('drops stale rows when activities for a tool are removed', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'myco_search', tool_input: { query: 'x' } },
      { tool_name: 'myco_plans',  tool_input: { op: 'list' } },
    ]);
    materializeSessionMycoToolCalls(SESSION_ID);
    expect(getSessionMycoToolCallCounts(SESSION_ID).length).toBe(2);

    const db = getDatabase();
    db.prepare(`DELETE FROM activities WHERE session_id = ? AND tool_name = 'myco_plans'`).run(SESSION_ID);
    materializeSessionMycoToolCalls(SESSION_ID);
    expect(getSessionMycoToolCallCounts(SESSION_ID)).toEqual([
      { tool_name: 'myco_search', op: '', count: 1 },
    ]);
  });

  it('returns null for a non-existent session', () => {
    expect(materializeSessionMycoToolCalls('sess_does_not_exist')).toBeNull();
  });

  it('writes zero rows when the session has no Myco activity', () => {
    seedSession();
    seedActivities(SESSION_ID, [{ tool_name: 'Read', tool_input: { file_path: '/x' } }]);
    expect(materializeSessionMycoToolCalls(SESSION_ID)).toBe(0);
    expect(getSessionMycoToolCallCounts(SESSION_ID)).toEqual([]);
  });
});

describe('getSessionMycoToolCallCounts — read side', () => {
  it('orders results by descending count, then tool_name, then op', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'myco_plans',  tool_input: { op: 'list' } },
      { tool_name: 'myco_plans',  tool_input: { op: 'list' } },
      { tool_name: 'myco_plans',  tool_input: { op: 'list' } },
      { tool_name: 'myco_search', tool_input: { query: 'x' } },
      { tool_name: 'myco_search', tool_input: { query: 'y' } },
      { tool_name: 'myco_cortex', tool_input: { op: 'canopy_map' } },
    ]);
    materializeSessionMycoToolCalls(SESSION_ID);
    expect(getSessionMycoToolCallCounts(SESSION_ID)).toEqual([
      { tool_name: 'myco_plans',  op: 'list',       count: 3 },
      { tool_name: 'myco_search', op: '',           count: 2 },
      { tool_name: 'myco_cortex', op: 'canopy_map', count: 1 },
    ]);
  });
});
