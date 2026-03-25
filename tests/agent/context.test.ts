/**
 * Tests for vault context builder.
 *
 * Each test initializes an in-memory SQLite instance, creates the schema,
 * and verifies the markdown output of buildVaultContext.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
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
function createAgent(id: string): void {
  const db = getDatabase();
  const now = epochNow();
  db.prepare(
    `INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`,
  ).run(id, `agent-${id}`, now);
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
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    createAgent(TEST_AGENT_ID);
  });

  it('returns context with all zeros for empty vault', () => {
    const context = buildVaultContext(TEST_AGENT_ID);

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

  it('includes cursor position from agent state', () => {
    const now = epochNow();
    setState(TEST_AGENT_ID, 'last_processed_batch_id', '42', now);

    const context = buildVaultContext(TEST_AGENT_ID);

    expect(context).toContain('last_processed_batch_id: 42');
  });

  it('counts sessions correctly', () => {
    upsertSession(makeSession());
    upsertSession(makeSession());
    upsertSession(makeSession());

    const context = buildVaultContext(TEST_AGENT_ID);

    expect(context).toContain('total_sessions: 3');
  });

  it('counts only active spores', () => {
    const now = epochNow();

    insertSpore({
      id: 'spore-active-1',
      agent_id: TEST_AGENT_ID,
      observation_type: 'gotcha',
      content: 'Active one',
      status: 'active',
      created_at: now,
    });
    insertSpore({
      id: 'spore-active-2',
      agent_id: TEST_AGENT_ID,
      observation_type: 'decision',
      content: 'Active two',
      status: 'active',
      created_at: now,
    });
    insertSpore({
      id: 'spore-superseded',
      agent_id: TEST_AGENT_ID,
      observation_type: 'gotcha',
      content: 'Superseded',
      status: 'superseded',
      created_at: now,
    });

    const context = buildVaultContext(TEST_AGENT_ID);

    expect(context).toContain('total_active_spores: 2');
  });

  it('counts unprocessed batches', () => {
    const session = makeSession();
    upsertSession(session);

    const now = epochNow();
    insertBatch({ session_id: session.id, created_at: now, processed: 0 });
    insertBatch({ session_id: session.id, created_at: now, processed: 0 });
    insertBatch({ session_id: session.id, created_at: now, processed: 1 });

    const context = buildVaultContext(TEST_AGENT_ID);

    expect(context).toContain('unprocessed_batches: 2');
  });

  it('counts entities and edges', () => {
    const db = getDatabase();
    const now = epochNow();

    db.prepare(
      `INSERT INTO entities (id, agent_id, type, name, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('e1', TEST_AGENT_ID, 'component', 'CompA', now, now);
    db.prepare(
      `INSERT INTO entities (id, agent_id, type, name, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('e2', TEST_AGENT_ID, 'component', 'CompB', now, now);
    db.prepare(
      `INSERT INTO graph_edges (id, agent_id, source_id, source_type, target_id, target_type, type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('edge-1', TEST_AGENT_ID, 'e1', 'entity', 'e2', 'entity', 'depends_on', now);

    const context = buildVaultContext(TEST_AGENT_ID);

    expect(context).toContain('total_entities: 2');
    expect(context).toContain('total_edges: 1');
  });

  it('includes last digest timestamp', () => {
    const db = getDatabase();
    const digestTime = 1711234567;

    db.prepare(
      `INSERT INTO digest_extracts (agent_id, tier, content, generated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(TEST_AGENT_ID, 1500, 'some context', digestTime);
    db.prepare(
      `INSERT INTO digest_extracts (agent_id, tier, content, generated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(TEST_AGENT_ID, 3000, 'more context', digestTime + 100);

    const context = buildVaultContext(TEST_AGENT_ID);

    expect(context).toContain(`last_digest_at: ${digestTime + 100}`);
  });

  it('returns correct counts with populated vault', () => {
    const now = epochNow();
    const db = getDatabase();

    // Add 2 sessions
    upsertSession(makeSession());
    upsertSession(makeSession());

    // Add spores
    insertSpore({
      id: 'spore-1',
      agent_id: TEST_AGENT_ID,
      observation_type: 'gotcha',
      content: 'content',
      created_at: now,
    });

    // Add entity
    db.prepare(
      `INSERT INTO entities (id, agent_id, type, name, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('e1', TEST_AGENT_ID, 'concept', 'PGlite', now, now);

    // Set cursor state
    setState(TEST_AGENT_ID, 'last_processed_batch_id', '99', now);

    const context = buildVaultContext(TEST_AGENT_ID);

    expect(context).toContain('agent_id: test-agent');
    expect(context).toContain('last_processed_batch_id: 99');
    expect(context).toContain('total_sessions: 2');
    expect(context).toContain('total_active_spores: 1');
    expect(context).toContain('total_entities: 1');
    expect(context).toContain('total_edges: 0');
  });
});
