/**
 * Tests for the activity feed query helper.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises getActivityFeed, and tears down the database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { getActivityFeed } from '@myco/db/queries/feed.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Shared agent ID used across tests. */
const TEST_AGENT_ID = 'agent-feed-test';

describe('getActivityFeed', () => {
  beforeEach(async () => {
    const db = await initDatabase(); // in-memory
    await createSchema(db);
    // Insert agent required as FK for agent_runs and spores
    await registerAgent({
      id: TEST_AGENT_ID,
      name: 'Feed Test Agent',
      created_at: epochNow(),
    });
  });

  afterEach(async () => {
    await closeDatabase();
  });

  // ---------------------------------------------------------------------------
  // Empty feed
  // ---------------------------------------------------------------------------

  it('returns empty array when no data exists', async () => {
    const feed = await getActivityFeed();
    expect(feed).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Unified feed sorted by timestamp
  // ---------------------------------------------------------------------------

  it('returns entries from all three tables merged and sorted by timestamp DESC', async () => {
    const base = epochNow();

    // Session at base+30 (newest)
    await upsertSession({
      id: 'sess-feed-1',
      agent: 'claude-code',
      started_at: base + 30,
      created_at: base + 30,
      title: 'Feed Session',
    });

    // Agent run at base+20
    await insertRun({
      id: 'run-feed-1',
      agent_id: TEST_AGENT_ID,
      task: 'curate spores',
      status: 'completed',
      started_at: base + 20,
      completed_at: base + 20,
    });

    // Spore at base+10 (oldest)
    await insertSpore({
      id: 'spore-feed-1',
      agent_id: TEST_AGENT_ID,
      observation_type: 'gotcha',
      content: 'Watch out for PGlite file locks',
      created_at: base + 10,
    });

    const feed = await getActivityFeed();

    expect(feed).toHaveLength(3);

    // First entry should be the session (highest timestamp)
    expect(feed[0].type).toBe('session');
    expect(feed[0].id).toBe('sess-feed-1');
    expect(feed[0].summary).toBe('Feed Session');
    expect(feed[0].timestamp).toBe(base + 30);

    // Second entry should be the agent run
    expect(feed[1].type).toBe('agent_run');
    expect(feed[1].id).toBe('run-feed-1');
    expect(feed[1].summary).toBe('curate spores — completed');
    expect(feed[1].timestamp).toBe(base + 20);

    // Third entry should be the spore
    expect(feed[2].type).toBe('spore');
    expect(feed[2].id).toBe('spore-feed-1');
    expect(feed[2].summary).toContain('gotcha:');
    expect(feed[2].summary).toContain('Watch out for PGlite file locks');
    expect(feed[2].timestamp).toBe(base + 10);
  });

  // ---------------------------------------------------------------------------
  // Session fallback title
  // ---------------------------------------------------------------------------

  it('uses fallback title for sessions without a title', async () => {
    const now = epochNow();
    const sessionId = 'abcdefgh-1234-5678-abcd-ef0123456789';

    await upsertSession({
      id: sessionId,
      agent: 'claude-code',
      started_at: now,
      created_at: now,
      title: null,
    });

    const feed = await getActivityFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0].summary).toBe('Session abcdefgh');
  });

  // ---------------------------------------------------------------------------
  // Spore content truncation to 80 chars
  // ---------------------------------------------------------------------------

  it('truncates long spore content to 80 chars in summary', async () => {
    const now = epochNow();
    const longContent = 'A'.repeat(200);

    await insertSpore({
      id: 'spore-long',
      agent_id: TEST_AGENT_ID,
      observation_type: 'decision',
      content: longContent,
      created_at: now,
    });

    const feed = await getActivityFeed();
    expect(feed).toHaveLength(1);
    // summary = "decision: " + LEFT(content, 80) = "decision: " + 80 A's
    expect(feed[0].summary).toBe('decision: ' + 'A'.repeat(80));
  });

  // ---------------------------------------------------------------------------
  // Spores with non-active status excluded
  // ---------------------------------------------------------------------------

  it('excludes spores with non-active status', async () => {
    const now = epochNow();

    await insertSpore({
      id: 'spore-active',
      agent_id: TEST_AGENT_ID,
      observation_type: 'gotcha',
      content: 'Active spore',
      created_at: now,
      status: 'active',
    });

    await insertSpore({
      id: 'spore-superseded',
      agent_id: TEST_AGENT_ID,
      observation_type: 'gotcha',
      content: 'Superseded spore',
      created_at: now + 1,
      status: 'superseded',
    });

    const feed = await getActivityFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0].id).toBe('spore-active');
  });

  // ---------------------------------------------------------------------------
  // Limit parameter respected
  // ---------------------------------------------------------------------------

  it('respects the limit parameter', async () => {
    const base = epochNow();

    // Insert 5 sessions with distinct timestamps
    for (let i = 0; i < 5; i++) {
      await upsertSession({
        id: `sess-limit-${i}`,
        agent: 'claude-code',
        started_at: base + i,
        created_at: base + i,
      });
    }

    const feed = await getActivityFeed(3);
    expect(feed).toHaveLength(3);
  });

  it('default limit is 50', async () => {
    const base = epochNow();

    // Insert 60 sessions
    for (let i = 0; i < 60; i++) {
      await upsertSession({
        id: `sess-def-${String(i).padStart(3, '0')}`,
        agent: 'claude-code',
        started_at: base + i,
        created_at: base + i,
      });
    }

    const feed = await getActivityFeed();
    expect(feed).toHaveLength(50);
  });

  // ---------------------------------------------------------------------------
  // Agent run uses completed_at as timestamp when available
  // ---------------------------------------------------------------------------

  it('uses completed_at as timestamp for finished agent runs', async () => {
    const now = epochNow();

    await insertRun({
      id: 'run-done',
      agent_id: TEST_AGENT_ID,
      task: 'prune',
      status: 'completed',
      started_at: now,
      completed_at: now + 100,
    });

    const feed = await getActivityFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0].timestamp).toBe(now + 100);
  });

  // ---------------------------------------------------------------------------
  // Only data from requested sources returned
  // ---------------------------------------------------------------------------

  it('returns entries only from tables with data', async () => {
    const now = epochNow();

    // Only a spore — no sessions or runs
    await insertSpore({
      id: 'spore-only',
      agent_id: TEST_AGENT_ID,
      observation_type: 'discovery',
      content: 'Interesting finding',
      created_at: now,
    });

    const feed = await getActivityFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0].type).toBe('spore');
  });
});
