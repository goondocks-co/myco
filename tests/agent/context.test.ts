/**
 * Tests for vault context builder.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * and verifies the markdown output of buildVaultContext.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { upsertSession, type SessionInsert } from '@myco/db/queries/sessions.js';
import { insertBatch, type BatchInsert } from '@myco/db/queries/batches.js';
import { insertSpore, type SporeInsert } from '@myco/db/queries/spores.js';
import { setState } from '@myco/db/queries/agent-state.js';
import { buildVaultContext } from '@myco/agent/context.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = 'test-agent';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert an agent directly into the agents table. */
async function createAgent(id: string): Promise<void> {
  const db = getDatabase();
  const now = epochNow();
  await db.query(
    `INSERT INTO agents (id, name, created_at) VALUES ($1, $2, $3)`,
    [id, `agent-${id}`, now],
  );
}

/** Factory for minimal valid session data. */
function makeSession(overrides: Partial<SessionInsert> = {}): SessionInsert {
  const now = epochNow();
  return {
    id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    agent: 'claude-code',
    started_at: now,
    created_at: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildVaultContext', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await cleanTestDb();
    await createAgent(TEST_AGENT_ID);
  });

  it('returns context with all zeros for empty vault', async () => {
    const context = await buildVaultContext(TEST_AGENT_ID);

    expect(context).toContain('## Current Vault State');
    expect(context).toContain(`agent_id: ${TEST_AGENT_ID}`);
    expect(context).toContain('last_processed_batch_id: (unset)');
    expect(context).toContain('unprocessed_batches: 0');
    expect(context).toContain('total_sessions: 0');
    expect(context).toContain('total_active_spores: 0');
    expect(context).toContain('total_entities: 0');
    expect(context).toContain('total_edges: 0');
    expect(context).toContain('last_digest_at: 0');
  });

  it('includes cursor position from agent state', async () => {
    const now = epochNow();
    await setState(TEST_AGENT_ID, 'last_processed_batch_id', '42', now);

    const context = await buildVaultContext(TEST_AGENT_ID);

    expect(context).toContain('last_processed_batch_id: 42');
  });

  it('counts sessions correctly', async () => {
    await upsertSession(makeSession());
    await upsertSession(makeSession());
    await upsertSession(makeSession());

    const context = await buildVaultContext(TEST_AGENT_ID);

    expect(context).toContain('total_sessions: 3');
  });

  it('counts only active spores', async () => {
    const now = epochNow();

    await insertSpore({
      id: 'spore-active-1',
      agent_id: TEST_AGENT_ID,
      observation_type: 'gotcha',
      content: 'Active one',
      status: 'active',
      created_at: now,
    });
    await insertSpore({
      id: 'spore-active-2',
      agent_id: TEST_AGENT_ID,
      observation_type: 'decision',
      content: 'Active two',
      status: 'active',
      created_at: now,
    });
    await insertSpore({
      id: 'spore-superseded',
      agent_id: TEST_AGENT_ID,
      observation_type: 'gotcha',
      content: 'Superseded',
      status: 'superseded',
      created_at: now,
    });

    const context = await buildVaultContext(TEST_AGENT_ID);

    expect(context).toContain('total_active_spores: 2');
  });

  it('counts unprocessed batches', async () => {
    const session = makeSession();
    await upsertSession(session);

    const now = epochNow();
    await insertBatch({ session_id: session.id, created_at: now, processed: 0 });
    await insertBatch({ session_id: session.id, created_at: now, processed: 0 });
    await insertBatch({ session_id: session.id, created_at: now, processed: 1 });

    const context = await buildVaultContext(TEST_AGENT_ID);

    expect(context).toContain('unprocessed_batches: 2');
  });

  it('counts entities and edges', async () => {
    const db = getDatabase();
    const now = epochNow();

    await db.query(
      `INSERT INTO entities (id, agent_id, type, name, first_seen, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['e1', TEST_AGENT_ID, 'component', 'CompA', now, now],
    );
    await db.query(
      `INSERT INTO entities (id, agent_id, type, name, first_seen, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['e2', TEST_AGENT_ID, 'component', 'CompB', now, now],
    );
    await db.query(
      `INSERT INTO edges (agent_id, source_id, target_id, type, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [TEST_AGENT_ID, 'e1', 'e2', 'depends_on', now],
    );

    const context = await buildVaultContext(TEST_AGENT_ID);

    expect(context).toContain('total_entities: 2');
    expect(context).toContain('total_edges: 1');
  });

  it('includes last digest timestamp', async () => {
    const db = getDatabase();
    const digestTime = 1711234567;

    await db.query(
      `INSERT INTO digest_extracts (agent_id, tier, content, generated_at)
       VALUES ($1, $2, $3, $4)`,
      [TEST_AGENT_ID, 1500, 'some context', digestTime],
    );
    await db.query(
      `INSERT INTO digest_extracts (agent_id, tier, content, generated_at)
       VALUES ($1, $2, $3, $4)`,
      [TEST_AGENT_ID, 3000, 'more context', digestTime + 100],
    );

    const context = await buildVaultContext(TEST_AGENT_ID);

    expect(context).toContain(`last_digest_at: ${digestTime + 100}`);
  });

  it('returns correct counts with populated vault', async () => {
    const now = epochNow();
    const db = getDatabase();

    // Add 2 sessions
    await upsertSession(makeSession());
    await upsertSession(makeSession());

    // Add spores
    await insertSpore({
      id: 'spore-1',
      agent_id: TEST_AGENT_ID,
      observation_type: 'gotcha',
      content: 'content',
      created_at: now,
    });

    // Add entity
    await db.query(
      `INSERT INTO entities (id, agent_id, type, name, first_seen, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['e1', TEST_AGENT_ID, 'concept', 'PGlite', now, now],
    );

    // Set cursor state
    await setState(TEST_AGENT_ID, 'last_processed_batch_id', '99', now);

    const context = await buildVaultContext(TEST_AGENT_ID);

    expect(context).toContain('agent_id: test-agent');
    expect(context).toContain('last_processed_batch_id: 99');
    expect(context).toContain('total_sessions: 2');
    expect(context).toContain('total_active_spores: 1');
    expect(context).toContain('total_entities: 1');
    expect(context).toContain('total_edges: 0');
  });
});
