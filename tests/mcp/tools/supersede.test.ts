/**
 * Tests for myco_spores op:supersede.
 *
 * Calls the in-process service `supersedeSpore` (no HTTP). Verifies that the
 * source spore status flips to 'superseded' and a resolution_events row is
 * recorded.
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
    VALUES (?, ?, ?, 'discovery', 'active', 'seed', ?, 'local')
  `).run(id, projectId, agentId, 1700000000);
}

function requestContext(projectId: string) {
  return resolveLegacyRequestContext('/tmp/myco-spore-supersede-test/.myco', {
    projectRoot: `/workspace/${projectId}`,
    projectId,
    groveId: 'grove-test',
    machineId: 'machine-test',
    source: 'explicit',
  });
}

interface SupersedeResult {
  old_spore: string;
  new_spore: string;
  status: string;
}

describe('myco_spores op: supersede (in-process)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('supersedes a spore and returns the success envelope', async () => {
    seedAgent();
    seedSpore('old-spore');
    seedSpore('new-spore');

    const result = await handleMycoSpores({
      op: 'supersede',
      old_spore_id: 'old-spore',
      new_spore_id: 'new-spore',
      reason: 'Bug was fixed',
    }, mockClient()) as SupersedeResult;

    expect(result.status).toBe('superseded');
    expect(result.old_spore).toBe('old-spore');
    expect(result.new_spore).toBe('new-spore');
  });

  it('flips the source spore status to superseded', async () => {
    seedAgent();
    seedSpore('old-spore');
    seedSpore('new-spore');

    await handleMycoSpores({
      op: 'supersede',
      old_spore_id: 'old-spore',
      new_spore_id: 'new-spore',
      reason: 'reason',
    }, mockClient());

    const db = getDatabase();
    const row = db.prepare('SELECT status FROM spores WHERE id = ?').get('old-spore') as { status: string };
    expect(row.status).toBe('superseded');
  });

  it('records a resolution event with the supersede action', async () => {
    seedAgent();
    seedSpore('old-spore');
    seedSpore('new-spore');

    await handleMycoSpores({
      op: 'supersede',
      old_spore_id: 'old-spore',
      new_spore_id: 'new-spore',
      reason: 'reason',
    }, mockClient());

    const db = getDatabase();
    const event = db.prepare(
      `SELECT action, spore_id, new_spore_id, reason FROM resolution_events WHERE spore_id = ?`,
    ).get('old-spore') as { action: string; spore_id: string; new_spore_id: string; reason: string };
    expect(event.action).toBe('supersede');
    expect(event.spore_id).toBe('old-spore');
    expect(event.new_spore_id).toBe('new-spore');
    expect(event.reason).toBe('reason');
  });

  it('does not supersede a spore from another project context', async () => {
    seedAgent();
    seedSpore('old-spore', 'user', 'project-b');
    seedSpore('new-spore', 'user', 'project-a');

    const result = await handleMycoSpores({
      op: 'supersede',
      old_spore_id: 'old-spore',
      new_spore_id: 'new-spore',
      reason: 'wrong project',
    }, mockClient(), requestContext('project-a'));

    expect(result).toEqual({ ok: false, error: 'old_spore_id not found' });

    const db = getDatabase();
    const old = db.prepare('SELECT status FROM spores WHERE id = ?').get('old-spore') as { status: string };
    const eventCount = db.prepare('SELECT COUNT(*) AS count FROM resolution_events').get() as { count: number };
    expect(old.status).toBe('active');
    expect(eventCount.count).toBe(0);
  });

  it('rejects a replacement spore from another project context', async () => {
    seedAgent();
    seedSpore('old-spore', 'user', 'project-a');
    seedSpore('new-spore', 'user', 'project-b');

    const result = await handleMycoSpores({
      op: 'supersede',
      old_spore_id: 'old-spore',
      new_spore_id: 'new-spore',
      reason: 'wrong project',
    }, mockClient(), requestContext('project-a'));

    expect(result).toEqual({ ok: false, error: 'new_spore_id not found' });

    const db = getDatabase();
    const old = db.prepare('SELECT status FROM spores WHERE id = ?').get('old-spore') as { status: string };
    const eventCount = db.prepare('SELECT COUNT(*) AS count FROM resolution_events').get() as { count: number };
    expect(old.status).toBe('active');
    expect(eventCount.count).toBe(0);
  });

  it('rejects op:supersede without old_spore_id', async () => {
    const result = await handleMycoSpores({ op: 'supersede', new_spore_id: 'b' }, mockClient());
    expect(result).toEqual({ ok: false, error: 'old_spore_id is required for op: supersede' });
  });

  it('rejects op:supersede without new_spore_id', async () => {
    const result = await handleMycoSpores({ op: 'supersede', old_spore_id: 'a' }, mockClient());
    expect(result).toEqual({ ok: false, error: 'new_spore_id is required for op: supersede' });
  });
});
