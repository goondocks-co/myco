/**
 * Tests for materializeCanopyAggregates: runs the aggregation and writes
 * the result onto the sessions row.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { upsertSession, getSession } from '@myco/db/queries/sessions.js';
import { materializeCanopyAggregates } from '@myco/canopy/aggregate.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROJECT_ROOT = '/repo/myco';

const epochNow = () => Math.floor(Date.now() / 1000);

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

function seedRead(sessionId: string, filePath: string, injectionTokens: number | null, ts: number) {
  getDatabase()
    .prepare(`
      INSERT INTO activities (
        session_id, tool_name, tool_input, file_path, timestamp,
        processed, created_at, canopy_injection_tokens
      ) VALUES (?, 'Read', ?, ?, ?, 0, ?, ?)
    `)
    .run(sessionId, JSON.stringify({ file_path: filePath }), filePath, ts, ts, injectionTokens);
}

function seedCanopyEntry(path: string, tokens: number) {
  const now = epochNow();
  getDatabase()
    .prepare(`
      INSERT INTO canopy_entries (
        project_id, machine_id, path, content_hash, size_bytes, token_estimate,
        line_count, language, exports_json, imports_json, top_comment,
        mechanical_updated_at, llm_description, llm_updated_at
      ) VALUES (?, 'local', ?, 'h', 0, ?, 0, 'typescript', NULL, NULL, NULL, ?, NULL, NULL)
    `)
    .run(PROJECT_ID, path, tokens, now);
}

describe('materializeCanopyAggregates', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    getDatabase().prepare('DELETE FROM canopy_entries').run();
  });

  it('writes the aggregate onto the sessions row', () => {
    const sessionId = 'sess-mat-1';
    seedSession(sessionId);
    seedCanopyEntry('a.ts', 1000);
    seedRead(sessionId, 'a.ts', 80, epochNow());

    const result = materializeCanopyAggregates(sessionId);

    expect(result).not.toBeNull();
    expect(result!.injections_offered).toBe(1);
    expect(result!.skips_after_injection).toBe(1);
    expect(result!.tokens_saved).toBe(920);

    const session = getSession(sessionId, ALL_PROJECTS_SCOPE);
    expect(session).toBeDefined();
    expect(session!.canopy_injections_offered).toBe(1);
    expect(session!.canopy_injection_total_tokens).toBe(80);
    expect(session!.canopy_skips_after_injection).toBe(1);
    expect(session!.canopy_reads_after_injection).toBe(0);
    expect(session!.canopy_tokens_saved).toBe(920);
    expect(session!.canopy_redundant_reads).toBe(0);
  });

  it('overwrites prior values on subsequent calls (per-turn re-materialization)', () => {
    const sessionId = 'sess-mat-2';
    seedSession(sessionId);
    seedCanopyEntry('a.ts', 500);
    const t = epochNow();
    seedRead(sessionId, 'a.ts', 50, t);

    materializeCanopyAggregates(sessionId);
    let session = getSession(sessionId, ALL_PROJECTS_SCOPE);
    expect(session!.canopy_skips_after_injection).toBe(1);

    // Add a later same-path Read → previous skip becomes a read-after-injection.
    seedRead(sessionId, 'a.ts', null, t + 10);
    materializeCanopyAggregates(sessionId);
    session = getSession(sessionId, ALL_PROJECTS_SCOPE);
    expect(session!.canopy_skips_after_injection).toBe(0);
    expect(session!.canopy_reads_after_injection).toBe(1);
    expect(session!.canopy_tokens_saved).toBe(-50);
    expect(session!.canopy_redundant_reads).toBe(1);
  });

  it('short-circuits and leaves canopy columns NULL for a session with no injections', () => {
    const sessionId = 'sess-mat-empty';
    seedSession(sessionId);

    const result = materializeCanopyAggregates(sessionId);
    expect(result).toBeNull();

    const session = getSession(sessionId, ALL_PROJECTS_SCOPE);
    expect(session!.canopy_injections_offered).toBeNull();
    expect(session!.canopy_tokens_saved).toBeNull();
  });

  it('is a no-op for a session that does not exist', () => {
    const result = materializeCanopyAggregates('nonexistent-session');
    expect(result).toBeNull();
  });
});
