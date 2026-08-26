/**
 * The local `RunStore` must behave like the vault queries it wraps, and its
 * `mutateState` must actually be atomic against a real database.
 *
 * The atomicity assertion is the point: the port declares `mutateState` atomic,
 * and a declaration is not a gate. Here the property is exercised against real
 * SQLite with concurrent callers, so an implementation that quietly reads and
 * writes across a yield fails by name rather than passing on luck.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { epochSeconds } from '@myco/constants.js';
import { createLocalRunStore } from '@myco/agent/runtime/run-store-local.js';
import { serializeRunStore } from '@myco/agent/runtime/run-store.js';
import { projectScope, type GroveProjectId } from '@myco/grove/ids.js';
import { getState } from '@myco/db/queries/agent-state.js';

setupTestDb();
afterAll(teardownTestDb);

const PROJECT_ID = 'proj_conformance';
const AGENT_ID = 'myco-agent';
const SCOPE = { projectId: PROJECT_ID, agentId: AGENT_ID };
const BINDING = { scope: projectScope(PROJECT_ID as GroveProjectId), agentId: AGENT_ID };
const KEY = 'bundle-decisions';

beforeEach(() => {
  cleanTestDb();
  const db = getDatabase();
  // `agent_state.agent_id` is the only FK; `project_id` is plain TEXT.
  db.prepare('INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)')
    .run(SCOPE.agentId, SCOPE.agentId, epochSeconds());
});

describe('local RunStore conformance', () => {
  it('round-trips state through the port and the underlying query', async () => {
    const store = createLocalRunStore(BINDING);

    expect(await store.getState(KEY, PROJECT_ID)).toBeNull();

    await store.setState(KEY, '["first"]', PROJECT_ID);

    const viaPort = await store.getState(KEY, PROJECT_ID);
    expect(viaPort?.value).toBe('["first"]');

    // The port is not a private store: the vault query sees the same row.
    const viaQuery = getState(SCOPE.agentId, SCOPE.projectId, KEY);
    expect(viaQuery?.value).toBe('["first"]');
  });

  it('mutateState applies to the current value, not a stale read', async () => {
    const store = createLocalRunStore(BINDING);
    await store.setState(KEY, '["a"]', PROJECT_ID);

    await store.mutateState(KEY, (current) => {
      const parsed: string[] = current ? JSON.parse(current) : [];
      return JSON.stringify([...parsed, 'b']);
    }, PROJECT_ID);

    expect(JSON.parse((await store.getState(KEY, PROJECT_ID))!.value)).toEqual(['a', 'b']);
  });

  it('mutateState returning null leaves the value untouched', async () => {
    const store = createLocalRunStore(BINDING);
    await store.setState(KEY, '["keep"]', PROJECT_ID);

    await store.mutateState(KEY, () => null, PROJECT_ID);

    expect((await store.getState(KEY, PROJECT_ID))!.value).toBe('["keep"]');
  });

  it('GATE: concurrent mutateState calls do not lose a write', async () => {
    const store = serializeRunStore(createLocalRunStore(BINDING));

    const append = (id: string) => store.mutateState(KEY, (current) => {
      const parsed: string[] = current ? JSON.parse(current) : [];
      return JSON.stringify([...parsed, id]);
    }, PROJECT_ID);

    // Ten concurrent phases, as a wave would dispatch them.
    const ids = Array.from({ length: 10 }, (_, i) => `phase-${i}`);
    await Promise.all(ids.map(append));

    const survivors: string[] = JSON.parse((await store.getState(KEY, PROJECT_ID))!.value);
    expect(survivors).toHaveLength(10);
    expect([...survivors].sort()).toEqual([...ids].sort());
  });
});
