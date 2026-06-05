/**
 * Tests for myco_spores op:obsolete.
 *
 * Calls the in-process service `obsoleteSpore` (no HTTP). Verifies that the
 * spore status flips to 'obsolete' (the replacement-free retirement) and a
 * resolution_events row with the obsolete action is recorded.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleMycoSpores } from '@myco/tools/spores.js';
import { DaemonClient } from '@myco/hooks/client.js';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { resolveLegacyRequestContext } from '@myco/grove/request-context.js';

import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context';
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
    VALUES (?, ?, ?, 'discovery', 'active', 'seed', ?, 'local')
  `).run(id, projectId, agentId, 1700000000);
}

function requestContext(projectId: string) {
  return resolveLegacyRequestContext('/tmp/myco-spore-obsolete-test/.myco', {
    projectRoot: `/workspace/${projectId}`,
    projectId,
    groveId: 'grove-test',
    machineId: 'machine-test',
    source: 'explicit',
    // Explicit project/grove pivot = caller-asserted tenancy; the scope seam
    // binds a Grove-bound context to its project scope only when caller-asserted.
    tenancySource: 'caller',
  });
}

interface ObsoleteResult {
  spore: string;
  status: string;
}

describe('myco_spores op: obsolete (in-process)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('obsoletes a spore and returns the success envelope', async () => {
    seedAgent();
    seedSpore('dead-spore');

    const result = await handleMycoSpores({
      op: 'obsolete',
      id: 'dead-spore',
      reason: 'feature was dropped',
    }, mockClient(), TEST_REQUEST_CONTEXT) as ObsoleteResult;

    expect(result.status).toBe('obsolete');
    expect(result.spore).toBe('dead-spore');
  });

  it('flips the spore status to obsolete', async () => {
    seedAgent();
    seedSpore('dead-spore');

    await handleMycoSpores({
      op: 'obsolete',
      id: 'dead-spore',
      reason: 'no longer relevant',
    }, mockClient(), TEST_REQUEST_CONTEXT);

    const db = getDatabase();
    const row = db.prepare('SELECT status FROM spores WHERE id = ?').get('dead-spore') as { status: string };
    expect(row.status).toBe('obsolete');
  });

  it('excludes the obsoleted spore from active reads (the gate every retrieval path uses)', async () => {
    seedAgent();
    seedSpore('dead-spore');

    await handleMycoSpores({
      op: 'obsolete',
      id: 'dead-spore',
      reason: 'no longer relevant',
    }, mockClient(), TEST_REQUEST_CONTEXT);

    // Retrieval, search, embedding, feed, and the context-injection allowlist
    // all gate on status = 'active'. Pin that an obsoleted spore drops out of
    // that set so retirement actually removes it from every retrieval path.
    const db = getDatabase();
    const activeMatch = db.prepare(
      `SELECT COUNT(*) AS n FROM spores WHERE id = ? AND status = 'active'`,
    ).get('dead-spore') as { n: number };
    expect(activeMatch.n).toBe(0);
  });

  it('records a resolution event with the obsolete action and no replacement', async () => {
    seedAgent();
    seedSpore('dead-spore');

    await handleMycoSpores({
      op: 'obsolete',
      id: 'dead-spore',
      reason: 'dropped feature X',
    }, mockClient(), TEST_REQUEST_CONTEXT);

    const db = getDatabase();
    const event = db.prepare(
      `SELECT action, spore_id, new_spore_id, reason FROM resolution_events WHERE spore_id = ?`,
    ).get('dead-spore') as { action: string; spore_id: string; new_spore_id: string | null; reason: string };
    expect(event.action).toBe('obsolete');
    expect(event.spore_id).toBe('dead-spore');
    expect(event.new_spore_id).toBeNull();
    expect(event.reason).toBe('dropped feature X');
  });

  it('does not obsolete a spore from another project context', async () => {
    seedAgent();
    seedSpore('dead-spore', 'user', 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    const result = await handleMycoSpores({
      op: 'obsolete',
      id: 'dead-spore',
      reason: 'wrong project',
    }, mockClient(), requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));

    expect(result).toEqual({ ok: false, error: 'spore_id not found' });

    const db = getDatabase();
    const row = db.prepare('SELECT status FROM spores WHERE id = ?').get('dead-spore') as { status: string };
    const eventCount = db.prepare('SELECT COUNT(*) AS count FROM resolution_events').get() as { count: number };
    expect(row.status).toBe('active');
    expect(eventCount.count).toBe(0);
  });

  it('rejects op:obsolete without id', async () => {
    const result = await handleMycoSpores({ op: 'obsolete', reason: 'x' }, mockClient(), TEST_REQUEST_CONTEXT);
    expect(result).toEqual({ ok: false, error: 'id is required for op: obsolete' });
  });

  it('rejects op:obsolete without a reason', async () => {
    seedAgent();
    seedSpore('dead-spore');
    const result = await handleMycoSpores({ op: 'obsolete', id: 'dead-spore' }, mockClient(), TEST_REQUEST_CONTEXT);
    expect(result).toEqual({ ok: false, error: 'reason is required for op: obsolete' });
  });
});
