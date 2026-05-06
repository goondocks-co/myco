/**
 * Tests for myco_spores op:consolidate.
 *
 * Calls the in-process service `consolidateSpores` (no HTTP). Verifies the new
 * wisdom spore is created, all sources are flipped to 'superseded' inside one
 * transaction, and a resolution_events row is recorded for each source.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleMycoSpores } from '@myco/tools/spores.js';
import { DaemonClient } from '@myco/hooks/client.js';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { resolveLegacyRequestContext } from '@myco/tools/request-context.js';

function mockClient(): DaemonClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
  } as unknown as DaemonClient;
}

function seedAgent(id = 'user'): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, name, created_at) VALUES (?, ?, ?)`,
  ).run(id, 'User', 1700000000);
}

function seedSpore(id: string, agentId = 'user', projectId: string | null = null): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at, machine_id)
    VALUES (?, ?, ?, 'gotcha', 'active', 'seed', ?, 'local')
  `).run(id, projectId, agentId, 1700000000);
}

function requestContext(projectId: string) {
  return resolveLegacyRequestContext('/tmp/myco-spore-consolidate-test/.myco', {
    projectRoot: `/workspace/${projectId}`,
    projectId,
    groveId: 'grove-test',
    machineId: 'machine-test',
    source: 'explicit',
  });
}

interface ConsolidateResult {
  new_spore_id: string;
  sources_superseded: string[];
  status: string;
  created_at: number;
}

describe('myco_spores op: consolidate (in-process)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('inserts a wisdom spore and supersedes all sources', async () => {
    seedAgent();
    seedSpore('g-1');
    seedSpore('g-2');
    seedSpore('g-3');

    const result = await handleMycoSpores({
      op: 'consolidate',
      source_spore_ids: ['g-1', 'g-2', 'g-3'],
      consolidated_content: '# Merged gotchas',
      observation_type: 'gotcha',
      tags: ['sqlite'],
      reason: 'Three SQLite gotchas',
    }, mockClient()) as ConsolidateResult;

    expect(result.status).toBe('consolidated');
    expect(result.new_spore_id).toMatch(/^gotcha-[0-9a-f]+$/);
    expect(result.sources_superseded).toEqual(['g-1', 'g-2', 'g-3']);

    const db = getDatabase();
    const wisdom = db.prepare('SELECT content, tags FROM spores WHERE id = ?').get(result.new_spore_id) as {
      content: string;
      tags: string;
    };
    expect(wisdom.content).toBe('# Merged gotchas');
    expect(wisdom.tags).toBe('sqlite');

    const sourceStatuses = db.prepare("SELECT id, status FROM spores WHERE id IN ('g-1', 'g-2', 'g-3') ORDER BY id").all() as Array<{ id: string; status: string }>;
    expect(sourceStatuses.map((r) => r.status)).toEqual(['superseded', 'superseded', 'superseded']);
  });

  it('records a resolution_events row per source', async () => {
    seedAgent();
    seedSpore('d-1');
    seedSpore('d-2');

    const result = await handleMycoSpores({
      op: 'consolidate',
      source_spore_ids: ['d-1', 'd-2'],
      consolidated_content: 'merged',
      observation_type: 'decision',
    }, mockClient()) as ConsolidateResult;

    const db = getDatabase();
    const events = db.prepare(`
      SELECT action, spore_id, new_spore_id FROM resolution_events
      WHERE new_spore_id = ? ORDER BY spore_id
    `).all(result.new_spore_id) as Array<{ action: string; spore_id: string; new_spore_id: string }>;
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.action === 'consolidate')).toBe(true);
    expect(events.map((e) => e.spore_id)).toEqual(['d-1', 'd-2']);
  });

  it('does not consolidate a source spore from another project context', async () => {
    seedAgent();
    seedSpore('g-1', 'user', 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    seedSpore('g-2', 'user', 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    const result = await handleMycoSpores({
      op: 'consolidate',
      source_spore_ids: ['g-1', 'g-2'],
      consolidated_content: '# Merged gotchas',
      observation_type: 'gotcha',
      reason: 'mixed projects',
    }, mockClient(), requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));

    expect(result).toEqual({ ok: false, error: 'source_spore_id not found: g-2' });

    const db = getDatabase();
    const statuses = db.prepare("SELECT id, status FROM spores WHERE id IN ('g-1', 'g-2') ORDER BY id").all() as Array<{ id: string; status: string }>;
    const wisdomCount = db.prepare("SELECT COUNT(*) AS count FROM spores WHERE content = '# Merged gotchas'").get() as { count: number };
    const eventCount = db.prepare('SELECT COUNT(*) AS count FROM resolution_events').get() as { count: number };
    expect(statuses.map((row) => row.status)).toEqual(['active', 'active']);
    expect(wisdomCount.count).toBe(0);
    expect(eventCount.count).toBe(0);
  });

  it('rejects op:consolidate when source_spore_ids is empty', async () => {
    const result = await handleMycoSpores({
      op: 'consolidate',
      source_spore_ids: [],
      consolidated_content: 'x',
      observation_type: 'gotcha',
    }, mockClient());
    expect(result).toEqual({ ok: false, error: 'source_spore_ids is required for op: consolidate' });
  });

  it('rejects op:consolidate when consolidated_content is missing', async () => {
    const result = await handleMycoSpores({
      op: 'consolidate',
      source_spore_ids: ['a', 'b'],
      observation_type: 'gotcha',
    }, mockClient());
    expect(result).toEqual({ ok: false, error: 'consolidated_content is required for op: consolidate' });
  });

  it('rejects op:consolidate when observation_type is missing', async () => {
    const result = await handleMycoSpores({
      op: 'consolidate',
      source_spore_ids: ['a', 'b'],
      consolidated_content: 'x',
    }, mockClient());
    expect(result).toEqual({ ok: false, error: 'observation_type is required for op: consolidate' });
  });
});
