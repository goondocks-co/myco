/**
 * Tests for the per-session Canopy aggregation SQL.
 *
 * Each scenario seeds an in-memory SQLite vault with:
 *   - a sessions row with project_id pointing at the fixture Canopy project
 *   - activities rows representing Read tool-calls (with/without injection)
 *   - canopy_entries rows providing the file_tokens for the LEFT JOIN
 *
 * Then asserts the aggregate matches hand-computed values.
 *
 * Coverage matrix (per plan Task C.1):
 *   - all-skip
 *   - all-read (read-anyway)
 *   - mixed (skip + read-anyway)
 *   - no-injection (pre-feature / disabled)
 *   - redundant reads (same path read >1 time)
 *   - tool-calls of other types are ignored
 *   - missing canopy_entries row is conservative (file_tokens=0)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import {
  aggregateSessionCanopy,
  rollupCanopy,
  listCanopyReads,
  getCanopyToolCallContext,
} from '@myco/db/queries/canopy.js';
import { ALL_PROJECTS_SCOPE, createGroveEraId } from '@myco/grove/ids.js';

const PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROJECT_ROOT = '/repo/myco';

const epochNow = () => Math.floor(Date.now() / 1000);

interface SeedActivity {
  /** Tool name; defaults to 'Read'. */
  tool_name?: string;
  file_path: string | null;
  injection_tokens?: number | null;
  /** Relative timestamp offset (seconds); seed ordering matches insertion order. */
  ts?: number;
}

interface SeedCanopyEntry {
  path: string;
  token_estimate: number;
}

function seedSession(sessionId: string) {
  const now = epochNow();
  upsertSession({
    id: sessionId,
    agent: 'claude-code',
    started_at: now,
    created_at: now,
    project_id: PROJECT_ID,
    project_root: PROJECT_ROOT,
  });
}

function seedActivities(sessionId: string, activities: SeedActivity[]) {
  const db = getDatabase();
  const base = epochNow();
  // v43 invariant: activities.prompt_batch_id is NOT NULL. Open a batch
  // for the session and reuse its id for every seeded activity.
  const batchId = createGroveEraId('prompt_batch');
  db.prepare(`
    INSERT INTO prompt_batches (id, session_id, prompt_number, started_at, created_at, status)
    VALUES (?, ?, 1, ?, ?, 'active')
  `).run(batchId, sessionId, base, base);

  const insert = db.prepare(`
    INSERT INTO activities (
      session_id, prompt_batch_id, tool_name, tool_input, file_path,
      timestamp, processed, created_at, canopy_injection_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);
  activities.forEach((a, i) => {
    const path = a.file_path;
    const toolInput = path === null ? null : JSON.stringify({ file_path: path });
    insert.run(
      sessionId,
      batchId,
      a.tool_name ?? 'Read',
      toolInput,
      path,
      base + (a.ts ?? i),
      base + (a.ts ?? i),
      a.injection_tokens ?? null,
    );
  });
}

function seedCanopyEntries(entries: SeedCanopyEntry[]) {
  const db = getDatabase();
  const insert = db.prepare(`
    INSERT INTO canopy_entries (
      project_id, machine_id, path, content_hash, size_bytes, token_estimate,
      line_count, language, exports_json, imports_json, top_comment,
      mechanical_updated_at, llm_description, llm_updated_at
    ) VALUES (?, 'local', ?, 'hash', 0, ?, 0, 'typescript', NULL, NULL, NULL, ?, NULL, NULL)
  `);
  const now = epochNow();
  for (const e of entries) {
    insert.run(PROJECT_ID, e.path, e.token_estimate, now);
  }
}

describe('aggregateSessionCanopy', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    // canopy_entries isn't in the shared cleanup list — wipe manually.
    getDatabase().prepare('DELETE FROM canopy_entries').run();
  });

  it('returns zeros for a session with no Read activities', () => {
    const sessionId = 'sess-empty';
    seedSession(sessionId);

    const agg = aggregateSessionCanopy(null, sessionId);

    expect(agg).toEqual({
      injections_offered: 0,
      injection_total_tokens: 0,
      skips_after_injection: 0,
      reads_after_injection: 0,
      tokens_saved: 0,
      redundant_reads: 0,
    });
  });

  it('counts only Read activities', () => {
    const sessionId = 'sess-non-read';
    seedSession(sessionId);
    seedCanopyEntries([{ path: 'a.ts', token_estimate: 1000 }]);
    seedActivities(sessionId, [
      { tool_name: 'Edit', file_path: 'a.ts', injection_tokens: 80 },
      { tool_name: 'Bash', file_path: null, injection_tokens: null },
    ]);

    const agg = aggregateSessionCanopy(null, sessionId);

    expect(agg.injections_offered).toBe(0);
    expect(agg.injection_total_tokens).toBe(0);
    expect(agg.tokens_saved).toBe(0);
  });

  it('all-skip: every injection saves (file_tokens - injection_tokens)', () => {
    const sessionId = 'sess-all-skip';
    seedSession(sessionId);
    seedCanopyEntries([
      { path: 'a.ts', token_estimate: 1000 },
      { path: 'b.ts', token_estimate: 2000 },
    ]);
    seedActivities(sessionId, [
      { file_path: 'a.ts', injection_tokens: 80 },
      { file_path: 'b.ts', injection_tokens: 90 },
    ]);

    const agg = aggregateSessionCanopy(null, sessionId);

    expect(agg.injections_offered).toBe(2);
    expect(agg.injection_total_tokens).toBe(170);
    expect(agg.skips_after_injection).toBe(2);
    expect(agg.reads_after_injection).toBe(0);
    // (1000-80) + (2000-90) = 2830
    expect(agg.tokens_saved).toBe(2830);
    expect(agg.redundant_reads).toBe(0);
  });

  it('all-read (read-anyway): every injection costs injection_tokens', () => {
    const sessionId = 'sess-all-read';
    seedSession(sessionId);
    seedCanopyEntries([{ path: 'a.ts', token_estimate: 1000 }]);
    // First Read carries the injection; the second is the agent reading anyway.
    seedActivities(sessionId, [
      { file_path: 'a.ts', injection_tokens: 80, ts: 1 },
      { file_path: 'a.ts', injection_tokens: null, ts: 2 },
    ]);

    const agg = aggregateSessionCanopy(null, sessionId);

    expect(agg.injections_offered).toBe(1);
    expect(agg.injection_total_tokens).toBe(80);
    expect(agg.skips_after_injection).toBe(0);
    expect(agg.reads_after_injection).toBe(1);
    expect(agg.tokens_saved).toBe(-80);
    // Same path read twice → 1 redundant pair.
    expect(agg.redundant_reads).toBe(1);
  });

  it('mixed: skip on one path, read-anyway on another', () => {
    const sessionId = 'sess-mixed';
    seedSession(sessionId);
    seedCanopyEntries([
      { path: 'skipped.ts', token_estimate: 1500 },
      { path: 'read.ts', token_estimate: 2000 },
    ]);
    seedActivities(sessionId, [
      { file_path: 'skipped.ts', injection_tokens: 100, ts: 1 },
      { file_path: 'read.ts',    injection_tokens: 90,  ts: 2 },
      { file_path: 'read.ts',    injection_tokens: null, ts: 3 },
    ]);

    const agg = aggregateSessionCanopy(null, sessionId);

    expect(agg.injections_offered).toBe(2);
    expect(agg.injection_total_tokens).toBe(190);
    expect(agg.skips_after_injection).toBe(1);
    expect(agg.reads_after_injection).toBe(1);
    // Skip: (1500 - 100) = 1400. Read-anyway: -90. Net = 1310.
    expect(agg.tokens_saved).toBe(1310);
    // 'read.ts' appears twice → 1 redundant pair; 'skipped.ts' only once.
    expect(agg.redundant_reads).toBe(1);
  });

  it('no-injection: pre-feature or disabled session → all aggregates are zero', () => {
    const sessionId = 'sess-no-inject';
    seedSession(sessionId);
    seedCanopyEntries([{ path: 'a.ts', token_estimate: 1000 }]);
    seedActivities(sessionId, [
      { file_path: 'a.ts', injection_tokens: null },
      { file_path: 'b.ts', injection_tokens: null },
    ]);

    const agg = aggregateSessionCanopy(null, sessionId);

    expect(agg.injections_offered).toBe(0);
    expect(agg.injection_total_tokens).toBe(0);
    expect(agg.skips_after_injection).toBe(0);
    expect(agg.reads_after_injection).toBe(0);
    expect(agg.tokens_saved).toBe(0);
    expect(agg.redundant_reads).toBe(0);
  });

  it('counts redundant reads independently of injection state', () => {
    const sessionId = 'sess-redundant';
    seedSession(sessionId);
    seedActivities(sessionId, [
      { file_path: 'a.ts', injection_tokens: null, ts: 1 },
      { file_path: 'a.ts', injection_tokens: null, ts: 2 },
      { file_path: 'a.ts', injection_tokens: null, ts: 3 },
      { file_path: 'b.ts', injection_tokens: null, ts: 4 },
    ]);

    const agg = aggregateSessionCanopy(null, sessionId);

    // 'a.ts' appears 3 times → 1 redundant *pair* (group counted once).
    // 'b.ts' once → not redundant. The metric is "files read more than once."
    expect(agg.redundant_reads).toBe(1);
  });

  it('falls back to 0 file_tokens when canopy_entries row is missing', () => {
    const sessionId = 'sess-missing-entry';
    seedSession(sessionId);
    // No canopy_entries seeded.
    seedActivities(sessionId, [
      { file_path: 'unknown.ts', injection_tokens: 50 },
    ]);

    const agg = aggregateSessionCanopy(null, sessionId);

    expect(agg.injections_offered).toBe(1);
    // Skip credit = (file_tokens 0) - (injection 50) = -50; conservative.
    expect(agg.skips_after_injection).toBe(1);
    expect(agg.tokens_saved).toBe(-50);
  });

  it('does not count later Reads of a different path as the same-path Read', () => {
    const sessionId = 'sess-different-paths';
    seedSession(sessionId);
    seedCanopyEntries([{ path: 'a.ts', token_estimate: 1000 }]);
    seedActivities(sessionId, [
      { file_path: 'a.ts', injection_tokens: 80, ts: 1 },
      { file_path: 'b.ts', injection_tokens: null, ts: 2 },
    ]);

    const agg = aggregateSessionCanopy(null, sessionId);
    // a.ts's injection counts as a skip (no later Read of a.ts).
    expect(agg.skips_after_injection).toBe(1);
    expect(agg.reads_after_injection).toBe(0);
    expect(agg.tokens_saved).toBe(920); // 1000 - 80
  });

  it('does not treat earlier same-second Reads as later Reads', () => {
    const sessionId = 'sess-same-second';
    seedSession(sessionId);
    seedCanopyEntries([{ path: 'a.ts', token_estimate: 1000 }]);
    seedActivities(sessionId, [
      { file_path: 'a.ts', injection_tokens: null, ts: 10 },
      { file_path: 'a.ts', injection_tokens: 80, ts: 10 },
    ]);

    const agg = aggregateSessionCanopy(null, sessionId);

    expect(agg.skips_after_injection).toBe(1);
    expect(agg.reads_after_injection).toBe(0);
    expect(agg.tokens_saved).toBe(920);
  });

  it('counts Codex Bash activities (manifest-driven tool-name allowlist)', () => {
    // Codex routes file reads through Bash with the path embedded in the
    // command string. PostToolUse stamps canopy_injection_tokens on those
    // rows. The aggregator must include them via the manifest-driven
    // tool-name filter, not the legacy `tool_name = 'Read'` hardcode.
    const sessionId = 'sess-codex-bash';
    seedSession(sessionId);
    seedCanopyEntries([{ path: 'src/x.ts', token_estimate: 1500 }]);
    seedActivities(sessionId, [
      { tool_name: 'Bash', file_path: 'src/x.ts', injection_tokens: 70, ts: 1 },
    ]);

    const agg = aggregateSessionCanopy(null, sessionId);

    expect(agg.injections_offered).toBe(1);
    expect(agg.injection_total_tokens).toBe(70);
    expect(agg.skips_after_injection).toBe(1);
    expect(agg.reads_after_injection).toBe(0);
    expect(agg.tokens_saved).toBe(1430); // 1500 - 70
  });

  it('counts mixed Claude Read and Codex Bash activities in one session', () => {
    const sessionId = 'sess-mixed-agents';
    seedSession(sessionId);
    seedCanopyEntries([
      { path: 'a.ts', token_estimate: 1000 },
      { path: 'b.ts', token_estimate: 2000 },
    ]);
    seedActivities(sessionId, [
      { tool_name: 'Read', file_path: 'a.ts', injection_tokens: 80, ts: 1 },
      { tool_name: 'Bash', file_path: 'b.ts', injection_tokens: 90, ts: 2 },
    ]);

    const agg = aggregateSessionCanopy(null, sessionId);

    expect(agg.injections_offered).toBe(2);
    expect(agg.injection_total_tokens).toBe(170);
    expect(agg.skips_after_injection).toBe(2);
    expect(agg.tokens_saved).toBe(2830); // (1000-80) + (2000-90)
  });

  it('canonicalizes absolute Read paths before joining canopy_entries', () => {
    const sessionId = 'sess-absolute-path';
    seedSession(sessionId);
    seedCanopyEntries([{ path: 'src/a.ts', token_estimate: 1000 }]);
    seedActivities(sessionId, [
      { file_path: `${PROJECT_ROOT}/src/a.ts`, injection_tokens: 80, ts: 1 },
    ]);

    const agg = aggregateSessionCanopy(null, sessionId);

    expect(agg.skips_after_injection).toBe(1);
    expect(agg.tokens_saved).toBe(920);
  });

  it('prefers normalized activity file_path over raw absolute tool_input path', () => {
    const sessionId = 'sess-normalized-path';
    seedSession(sessionId);
    seedCanopyEntries([{ path: 'src/a.ts', token_estimate: 1000 }]);
    seedActivities(sessionId, [
      { file_path: 'src/a.ts', injection_tokens: 80, ts: 1 },
    ]);
    getDatabase()
      .prepare(`UPDATE activities SET tool_input = ? WHERE session_id = ?`)
      .run(JSON.stringify({ file_path: '/tmp/worktrees/feature/src/a.ts' }), sessionId);

    const agg = aggregateSessionCanopy(null, sessionId);

    expect(agg.skips_after_injection).toBe(1);
    expect(agg.tokens_saved).toBe(920);
  });
});

describe('listCanopyReads (per-tool-call indicators)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    getDatabase().prepare('DELETE FROM canopy_entries').run();
  });

  it('returns Codex Bash rows alongside Claude Read rows (manifest-driven allowlist)', () => {
    // Mirrors the aggregate-side guarantee: the per-tool-call drilldown that
    // backs /sessions/:id/canopy must include the same set of activities the
    // aggregate counts, or the UI shows "5 injections offered" with zero rows.
    const sessionId = 'sess-list-mixed';
    seedSession(sessionId);
    seedActivities(sessionId, [
      { tool_name: 'Read', file_path: 'a.ts', injection_tokens: 80, ts: 1 },
      { tool_name: 'Bash', file_path: 'b.ts', injection_tokens: 90, ts: 2 },
      // A non-read tool is excluded — same predicate as the aggregate.
      { tool_name: 'Edit', file_path: 'c.ts', injection_tokens: 50, ts: 3 },
    ]);

    const rows = listCanopyReads(null, sessionId);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.file_path).sort()).toEqual(['a.ts', 'b.ts']);
    expect(rows.find(r => r.file_path === 'b.ts')?.canopy_injection_tokens).toBe(90);
  });
});

describe('getCanopyToolCallContext (read-replay endpoint)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    getDatabase().prepare('DELETE FROM canopy_entries').run();
  });

  it('resolves a Codex Bash tool-call as a canopy read (manifest-driven allowlist)', () => {
    const sessionId = 'sess-ctx-bash';
    seedSession(sessionId);
    seedCanopyEntries([{ path: 'src/x.ts', token_estimate: 1500 }]);
    seedActivities(sessionId, [
      { tool_name: 'Bash', file_path: 'src/x.ts', injection_tokens: 70, ts: 1 },
    ]);

    // Recover the inserted activity id directly — seedActivities doesn't return
    // it, but it's the only row for this session.
    const row = getDatabase()
      .prepare('SELECT id FROM activities WHERE session_id = ?')
      .get(sessionId) as { id: number };

    const ctx = getCanopyToolCallContext(ALL_PROJECTS_SCOPE, sessionId, row.id);
    expect(ctx).not.toBeNull();
    expect(ctx?.file_path).toBe('src/x.ts');
    expect(ctx?.injection_tokens).toBe(70);
  });
});

describe('rollupCanopy', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    getDatabase().prepare('DELETE FROM canopy_entries').run();
  });

  it('returns zero rollup with no sessions', () => {
    const r = rollupCanopy(ALL_PROJECTS_SCOPE);
    expect(r.sessions_with_data).toBe(0);
    expect(r.total_tokens_saved).toBe(0);
    expect(r.avg_tokens_saved_per_session).toBe(0);
    expect(r.skip_ratio).toBe(0);
  });

  it('aggregates only sessions with canopy_injections_offered IS NOT NULL', () => {
    const db = getDatabase();
    const now = epochNow();
    upsertSession({ id: 's1', agent: 'claude-code', started_at: now, created_at: now });
    upsertSession({ id: 's2', agent: 'claude-code', started_at: now, created_at: now });
    upsertSession({ id: 's3', agent: 'claude-code', started_at: now, created_at: now });
    // s1 — pre-feature, all NULL (excluded)
    // s2 — feature on, with data
    db.prepare(`
      UPDATE sessions SET
        canopy_injections_offered = 5,
        canopy_injection_total_tokens = 400,
        canopy_skips_after_injection = 4,
        canopy_reads_after_injection = 1,
        canopy_tokens_saved = 1000,
        canopy_redundant_reads = 0
      WHERE id = ?
    `).run('s2');
    // s3 — feature on, with data
    db.prepare(`
      UPDATE sessions SET
        canopy_injections_offered = 3,
        canopy_injection_total_tokens = 200,
        canopy_skips_after_injection = 1,
        canopy_reads_after_injection = 2,
        canopy_tokens_saved = 500,
        canopy_redundant_reads = 0
      WHERE id = ?
    `).run('s3');

    const r = rollupCanopy(ALL_PROJECTS_SCOPE);
    expect(r.sessions_with_data).toBe(2);
    expect(r.total_tokens_saved).toBe(1500);
    expect(r.avg_tokens_saved_per_session).toBe(750);
    expect(r.total_injections_offered).toBe(8);
    expect(r.total_skips_after_injection).toBe(5);
    expect(r.skip_ratio).toBeCloseTo(5 / 8, 5);
  });

  it('respects since/until time bounds', () => {
    const db = getDatabase();
    upsertSession({ id: 'old', agent: 'claude-code', started_at: 100, created_at: 100 });
    upsertSession({ id: 'new', agent: 'claude-code', started_at: 200, created_at: 200 });
    db.prepare(`
      UPDATE sessions SET canopy_injections_offered = 1, canopy_skips_after_injection = 1,
        canopy_injection_total_tokens = 0, canopy_reads_after_injection = 0,
        canopy_tokens_saved = 100, canopy_redundant_reads = 0
      WHERE id = ?
    `).run('old');
    db.prepare(`
      UPDATE sessions SET canopy_injections_offered = 1, canopy_skips_after_injection = 1,
        canopy_injection_total_tokens = 0, canopy_reads_after_injection = 0,
        canopy_tokens_saved = 200, canopy_redundant_reads = 0
      WHERE id = ?
    `).run('new');

    const fresh = rollupCanopy(ALL_PROJECTS_SCOPE, { since: 150 });
    expect(fresh.sessions_with_data).toBe(1);
    expect(fresh.total_tokens_saved).toBe(200);

    const stale = rollupCanopy(ALL_PROJECTS_SCOPE, { until: 150 });
    expect(stale.sessions_with_data).toBe(1);
    expect(stale.total_tokens_saved).toBe(100);
  });
});
