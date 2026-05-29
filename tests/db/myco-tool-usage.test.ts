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
  getBatchMycoToolCalls,
  parseCliMycoToolCalls,
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

describe('getBatchMycoToolCalls — per-batch attribution', () => {
  /** Seed one batch and return its id (origin defaults to human). */
  function seedBatch(sessionId: string, origin = 'human'): number {
    const base = Math.floor(Date.now() / 1000);
    const info = getDatabase()
      .prepare(
        `INSERT INTO prompt_batches (session_id, prompt_number,
           started_at, created_at, status, origin)
         VALUES (?, (SELECT COALESCE(MAX(prompt_number),0)+1 FROM prompt_batches WHERE session_id=?), ?, ?, 'active', ?)`,
      )
      .run(sessionId, sessionId, base, base, origin);
    return Number(info.lastInsertRowid);
  }

  function addActivity(sessionId: string, batchId: number, tool_name: string, tool_input?: unknown) {
    const ts = Math.floor(Date.now() / 1000);
    getDatabase()
      .prepare(
        `INSERT INTO activities (session_id, prompt_batch_id, tool_name, tool_input,
                                 timestamp, processed, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        sessionId,
        batchId,
        tool_name,
        tool_input === undefined ? null : typeof tool_input === 'string' ? tool_input : JSON.stringify(tool_input),
        ts,
        ts,
      );
  }

  it('attributes MCP-routed calls to the batch they occurred in', () => {
    seedSession();
    const b1 = seedBatch(SESSION_ID);
    const b2 = seedBatch(SESSION_ID);
    addActivity(SESSION_ID, b1, 'mcp__myco__myco_search', { query: 'x' });
    addActivity(SESSION_ID, b2, 'mcp__myco__myco_cortex', { op: 'canopy_map' });
    addActivity(SESSION_ID, b2, 'mcp__myco__myco_cortex', { op: 'canopy_map' });

    const rows = getBatchMycoToolCalls(SESSION_ID).sort((a, b) => a.prompt_batch_id - b.prompt_batch_id);
    expect(rows).toEqual([
      { prompt_batch_id: b1, tool_name: 'myco_search', op: '', count: 1 },
      { prompt_batch_id: b2, tool_name: 'myco_cortex', op: 'canopy_map', count: 2 },
    ]);
  });

  it('attributes CLI-routed (Bash) calls to the batch, surfacing the myco tool not "Bash"', () => {
    seedSession();
    const b1 = seedBatch(SESSION_ID);
    addActivity(SESSION_ID, b1, 'Bash', {
      command: `node .agents/myco-cli.cjs tool call myco_spores --json --input '{"op":"save"}'`,
    });

    const rows = getBatchMycoToolCalls(SESSION_ID);
    expect(rows).toEqual([{ prompt_batch_id: b1, tool_name: 'myco_spores', op: 'save', count: 1 }]);
  });

  it('merges MCP + CLI calls under the same batch without double-counting', () => {
    seedSession();
    const b1 = seedBatch(SESSION_ID);
    addActivity(SESSION_ID, b1, 'mcp__myco__myco_search', { query: 'x' });
    addActivity(SESSION_ID, b1, 'Bash', { command: `myco tool call myco_search --input '{"query":"y"}'` });

    const rows = getBatchMycoToolCalls(SESSION_ID);
    expect(rows).toEqual([{ prompt_batch_id: b1, tool_name: 'myco_search', op: '', count: 2 }]);
  });

  it('ignores non-Myco activities', () => {
    seedSession();
    const b1 = seedBatch(SESSION_ID);
    addActivity(SESSION_ID, b1, 'Read', { file_path: '/x' });
    addActivity(SESSION_ID, b1, 'Bash', { command: 'ls -la' });
    expect(getBatchMycoToolCalls(SESSION_ID)).toEqual([]);
  });

  it('returns empty for a session with no Myco tool calls', () => {
    seedSession();
    expect(getBatchMycoToolCalls(SESSION_ID)).toEqual([]);
  });
});

describe('parseCliMycoToolCalls — CLI command parsing', () => {
  it('parses the skill-recommended launcher form with inline op', () => {
    expect(
      parseCliMycoToolCalls(`node .agents/myco-cli.cjs tool call myco_cortex --json --input '{"op":"canopy_map"}'`),
    ).toEqual([{ tool_name: 'myco_cortex', op: 'canopy_map' }]);
  });

  it('resolves op to empty string for --input @file (op not inline)', () => {
    expect(
      parseCliMycoToolCalls(`node .agents/myco-cli.cjs tool call myco_spores --json --input @/tmp/payload.json`),
    ).toEqual([{ tool_name: 'myco_spores', op: '' }]);
  });

  it('parses bare `myco` / `myco-dev` / `myco-run` launchers', () => {
    expect(parseCliMycoToolCalls(`myco tool call myco_search --input '{"query":"x"}'`)).toEqual([
      { tool_name: 'myco_search', op: '' },
    ]);
    expect(parseCliMycoToolCalls(`myco-dev tool call myco_plans --input '{"op":"list"}'`)).toEqual([
      { tool_name: 'myco_plans', op: 'list' },
    ]);
    expect(parseCliMycoToolCalls(`node .agents/myco-run.cjs tool call collective_search --input '{"query":"y"}'`)).toEqual([
      { tool_name: 'collective_search', op: '' },
    ]);
  });

  it('parses the plugin-bundle dist/src/cli.js launcher', () => {
    expect(
      parseCliMycoToolCalls(`node /opt/p/dist/src/cli.js tool call myco_cortex --input '{"op":"digest"}'`),
    ).toEqual([{ tool_name: 'myco_cortex', op: 'digest' }]);
  });

  it('parses multiple calls in one command, each with its own op', () => {
    const cmd = `myco tool call myco_cortex --input '{"op":"canopy_map"}' && myco tool call myco_plans --input '{"op":"list"}'`;
    expect(parseCliMycoToolCalls(cmd)).toEqual([
      { tool_name: 'myco_cortex', op: 'canopy_map' },
      { tool_name: 'myco_plans', op: 'list' },
    ]);
  });

  it('does not match prose or non-Myco tool names containing "tool call"', () => {
    expect(parseCliMycoToolCalls(`grep -r "tool call" packages/`)).toEqual([]);
    expect(parseCliMycoToolCalls(`echo "how to tool call something"`)).toEqual([]);
    expect(parseCliMycoToolCalls(`myco tool call something_else --input '{}'`)).toEqual([]);
  });

  // Regression: an op-less call followed by an unrelated command/argument
  // containing an "op" JSON fragment must NOT bleed that op onto the call.
  it('does not bleed an op from a trailing piped/chained command into an op-less call', () => {
    expect(
      parseCliMycoToolCalls(`myco tool call myco_spores --input @/tmp/p.json && echo '{"op":"canopy_map"}'`),
    ).toEqual([{ tool_name: 'myco_spores', op: '' }]);
    expect(
      parseCliMycoToolCalls(`myco tool call myco_search --input @file | grep '{"op":"x"}'`),
    ).toEqual([{ tool_name: 'myco_search', op: '' }]);
  });

  it('does not bleed an op from a trailing redirect/arg after the LAST call', () => {
    expect(
      parseCliMycoToolCalls(`myco tool call myco_search --input @file ; cat results.json`),
    ).toEqual([{ tool_name: 'myco_search', op: '' }]);
  });

  it('still captures the op from this call own --input before any separator', () => {
    expect(
      parseCliMycoToolCalls(`myco tool call myco_cortex --input '{"op":"digest"}' 2>&1`),
    ).toEqual([{ tool_name: 'myco_cortex', op: 'digest' }]);
  });
});

describe('aggregateSessionMycoToolCalls — CLI-routed calls (Bash activities)', () => {
  it('counts CLI tool calls embedded in shell activities', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'Bash', tool_input: { command: `node .agents/myco-cli.cjs tool call myco_cortex --json --input '{"op":"canopy_map"}'` } },
      { tool_name: 'Bash', tool_input: { command: `node .agents/myco-cli.cjs tool call myco_cortex --json --input '{"op":"canopy_map"}'` } },
      { tool_name: 'Bash', tool_input: { command: `node .agents/myco-cli.cjs tool call myco_search --json --input '{"query":"x"}'` } },
    ]);
    const result = aggregateSessionMycoToolCalls(null, SESSION_ID).sort((a, b) => a.tool_name.localeCompare(b.tool_name) || a.op.localeCompare(b.op));
    expect(result).toEqual([
      { tool_name: 'myco_cortex', op: 'canopy_map', count: 2 },
      { tool_name: 'myco_search', op: '', count: 1 },
    ]);
  });

  it('merges CLI-routed and MCP-routed calls into one canonical bucket', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'mcp__myco__myco_cortex', tool_input: { op: 'canopy_map' } },
      { tool_name: 'Bash', tool_input: { command: `node .agents/myco-cli.cjs tool call myco_cortex --input '{"op":"canopy_map"}'` } },
    ]);
    const result = aggregateSessionMycoToolCalls(null, SESSION_ID);
    expect(result).toEqual([{ tool_name: 'myco_cortex', op: 'canopy_map', count: 2 }]);
  });

  it('does not count plain shell activities with no myco-cli tool call', () => {
    seedSession();
    seedActivities(SESSION_ID, [
      { tool_name: 'Bash', tool_input: { command: 'ls -la && grep "tool call" file' } },
    ]);
    expect(aggregateSessionMycoToolCalls(null, SESSION_ID)).toEqual([]);
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
