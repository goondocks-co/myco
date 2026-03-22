/**
 * Tests for myco_sessions tool handler.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { handleMycoSessions } from '@myco/mcp/tools/sessions.js';

const epochNow = () => Math.floor(Date.now() / 1000);

describe('myco_sessions', () => {
  beforeEach(async () => {
    const db = await initDatabase();
    await createSchema(db);

    const now = epochNow();
    await upsertSession({
      id: 'sess-1', agent: 'claude-code', started_at: now - 100,
      created_at: now - 100, status: 'completed', title: 'Auth Refactor',
      summary: 'Refactored JWT middleware.',
    });
    await upsertSession({
      id: 'sess-2', agent: 'claude-code', started_at: now,
      created_at: now, status: 'active', title: 'Current Work',
      summary: 'Working on something.',
    });
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('lists all sessions', async () => {
    const results = await handleMycoSessions({});
    expect(results).toHaveLength(2);
  });

  it('filters by status', async () => {
    const results = await handleMycoSessions({ status: 'active' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('sess-2');
  });

  it('respects limit', async () => {
    const results = await handleMycoSessions({ limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('returns session summaries with expected fields', async () => {
    const results = await handleMycoSessions({});
    const session = results.find((s) => s.id === 'sess-1')!;
    expect(session.agent).toBe('claude-code');
    expect(session.title).toBe('Auth Refactor');
    expect(session.status).toBe('completed');
    expect(typeof session.started_at).toBe('number');
  });
});
