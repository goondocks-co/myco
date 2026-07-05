import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GroveRuntimeCache,
  DEFAULT_GROVE_RUNTIME_CACHE_CAPACITY,
  GROVE_RUNTIME_CACHE_CEILING,
  recommendCapacity,
} from '@myco/daemon/grove-runtime-cache.js';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { resolveDefinitionsDir, loadAgentTasks } from '@myco/agent/loader.js';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';

describe('GroveRuntimeCache', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-runtime-cache-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function dbPath(name: string): string {
    const file = path.join(workDir, `${name}.db`);
    const db = openDatabase(file);
    createSchema(db);
    db.close();
    return file;
  }

  function emptyDbPath(name: string): string {
    return path.join(workDir, `${name}.db`);
  }

  it('returns the same DB handle for repeat lookups', () => {
    const cache = new GroveRuntimeCache();
    const a = dbPath('a');
    const first = cache.getDatabase(a);
    const second = cache.getDatabase(a);
    expect(first).toBe(second);
    cache.closeAll();
  });

  it('initializes schema when opening a cold Grove database', () => {
    const cache = new GroveRuntimeCache();
    const cold = emptyDbPath('cold-grove');

    const db = cache.getDatabase(cold);

    const row = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'canopy_maps'",
    ).get() as { present: number } | undefined;
    expect(row?.present).toBe(1);
    cache.closeAll();
  });

  it('evicts the least-recently-used entry when capacity is exceeded', () => {
    const cache = new GroveRuntimeCache({ capacity: 2 });
    const a = dbPath('a');
    const b = dbPath('b');
    const c = dbPath('c');

    const dbA = cache.getDatabase(a);
    cache.getDatabase(b);
    cache.getDatabase(a); // touch A so B becomes LRU
    cache.getDatabase(c); // should evict B

    expect(cache.size()).toBe(2);
    // A is still cached: same handle reference.
    expect(cache.getDatabase(a)).toBe(dbA);
    cache.closeAll();
  });

  it('closes evicted resources', () => {
    const cache = new GroveRuntimeCache({ capacity: 1 });
    const a = dbPath('a');
    const b = dbPath('b');

    const dbA = cache.getDatabase(a);
    cache.getDatabase(b);
    expect(() => dbA.prepare('SELECT 1').get()).toThrow();
    cache.closeAll();
  });

  it('explicit evict closes and removes the entry', () => {
    const cache = new GroveRuntimeCache();
    const a = dbPath('a');
    const dbA = cache.getDatabase(a);

    cache.evict(a);
    expect(cache.size()).toBe(0);
    expect(() => dbA.prepare('SELECT 1').get()).toThrow();
  });

  it('pin prevents eviction even when capacity is exceeded', () => {
    const cache = new GroveRuntimeCache({ capacity: 2 });
    const a = dbPath('a');
    const b = dbPath('b');
    const c = dbPath('c');

    const dbA = cache.getDatabase(a);
    cache.pin(a);
    cache.getDatabase(b);
    cache.getDatabase(c); // would normally evict A (LRU); pinned, so B goes instead.

    expect(cache.size()).toBe(2);
    expect(cache.getDatabase(a)).toBe(dbA);
    cache.unpin(a);
    cache.closeAll();
  });

  it('cache may temporarily exceed capacity when every entry is pinned', () => {
    const cache = new GroveRuntimeCache({ capacity: 1 });
    const a = dbPath('a');
    const b = dbPath('b');

    cache.getDatabase(a);
    cache.pin(a);
    cache.getDatabase(b);
    cache.pin(b);

    expect(cache.size()).toBe(2);
    cache.unpin(a);
    // Next unpin/insert reclaims; nothing inserted, but unpin already triggered reclamation.
    expect(cache.size()).toBe(1);
    cache.unpin(b);
    cache.closeAll();
  });

  it('withPinned releases the pin synchronously', () => {
    const cache = new GroveRuntimeCache({ capacity: 1 });
    const a = dbPath('a');
    const b = dbPath('b');

    cache.getDatabase(a);
    cache.withPinned(a, () => {
      cache.getDatabase(b);
      expect(cache.size()).toBe(2);
    });
    cache.getDatabase(b);
    expect(cache.size()).toBe(1);
    cache.closeAll();
  });

  it('withPinned releases the pin after an async fn settles', async () => {
    const cache = new GroveRuntimeCache({ capacity: 1 });
    const a = dbPath('a');
    const b = dbPath('b');

    cache.getDatabase(a);
    await cache.withPinned(a, async () => {
      cache.getDatabase(b);
      expect(cache.size()).toBe(2);
    });
    cache.getDatabase(b);
    expect(cache.size()).toBe(1);
    cache.closeAll();
  });

  it('withPinned releases the pin even if fn throws', () => {
    const cache = new GroveRuntimeCache({ capacity: 1 });
    const a = dbPath('a');
    const b = dbPath('b');

    cache.getDatabase(a);
    expect(() =>
      cache.withPinned(a, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    cache.getDatabase(b);
    expect(cache.size()).toBe(1);
    cache.closeAll();
  });

  it('balanced pin/unpin pairs leave eviction free to remove the entry', () => {
    const cache = new GroveRuntimeCache({ capacity: 1 });
    const a = dbPath('a');
    const b = dbPath('b');

    cache.getDatabase(a);
    cache.pin(a);
    cache.pin(a);
    cache.unpin(a);
    cache.unpin(a);
    cache.getDatabase(b); // should evict A now that all pins are released
    expect(cache.size()).toBe(1);
    cache.closeAll();
  });

  describe('capacity defaults and auto-sizing', () => {
    it('default capacity is the many-Grove-friendly DEFAULT constant', () => {
      const cache = new GroveRuntimeCache();
      expect(cache.getCapacity()).toBe(DEFAULT_GROVE_RUNTIME_CACHE_CAPACITY);
      expect(DEFAULT_GROVE_RUNTIME_CACHE_CAPACITY).toBeGreaterThanOrEqual(32);
    });

    it('explicit capacity overrides the default', () => {
      const cache = new GroveRuntimeCache({ capacity: 4 });
      expect(cache.getCapacity()).toBe(4);
    });

    it('recommendCapacity returns at least the default for small Grove counts', () => {
      expect(recommendCapacity(0)).toBe(DEFAULT_GROVE_RUNTIME_CACHE_CAPACITY);
      expect(recommendCapacity(8)).toBe(DEFAULT_GROVE_RUNTIME_CACHE_CAPACITY);
    });

    it('recommendCapacity scales to 2x Grove count above the default', () => {
      const recommended = recommendCapacity(40);
      expect(recommended).toBe(80);
    });

    it('recommendCapacity caps at GROVE_RUNTIME_CACHE_CEILING', () => {
      expect(recommendCapacity(10_000)).toBe(GROVE_RUNTIME_CACHE_CEILING);
    });

    it('growCapacity grows the cache and never shrinks below current', () => {
      const cache = new GroveRuntimeCache({ capacity: 4 });
      expect(cache.growCapacity(16)).toBe(16);
      expect(cache.getCapacity()).toBe(16);
      // shrink attempts are ignored
      expect(cache.growCapacity(2)).toBe(16);
      expect(cache.getCapacity()).toBe(16);
    });

    it('growCapacity respects the hard ceiling', () => {
      const cache = new GroveRuntimeCache({ capacity: 4 });
      const out = cache.growCapacity(GROVE_RUNTIME_CACHE_CEILING + 1000);
      expect(out).toBe(GROVE_RUNTIME_CACHE_CEILING);
    });
  });

  // ---------------------------------------------------------------------------
  // Built-in agent/task seeding at the DB-open choke point: a fresh grove
  // opened via the cache path has built-in agents/tasks.
  // ---------------------------------------------------------------------------

  describe('built-in agent/task seeding', () => {
    it('a freshly opened Grove DB has the built-in agent + all built-in tasks', () => {
      const cache = new GroveRuntimeCache();
      const fresh = emptyDbPath('fresh-grove');

      const db = cache.getDatabase(fresh);

      const agentRow = db.prepare('SELECT id, source FROM agents WHERE id = ?').get(DEFAULT_AGENT_ID) as
        | { id: string; source: string }
        | undefined;
      expect(agentRow?.id).toBe(DEFAULT_AGENT_ID);
      expect(agentRow?.source).toBe('built-in');

      const expectedTaskCount = loadAgentTasks(resolveDefinitionsDir()).length;
      const taskRows = db.prepare(
        "SELECT id FROM agent_tasks WHERE source = 'built-in' AND agent_id = ?",
      ).all(DEFAULT_AGENT_ID) as Array<{ id: string }>;
      expect(taskRows).toHaveLength(expectedTaskCount);

      cache.closeAll();
    });

    it('re-opening an existing Grove DB is idempotent (self-heals a previously broken Grove)', () => {
      const cache = new GroveRuntimeCache();
      const target = emptyDbPath('reopen-grove');

      const first = cache.getDatabase(target);
      const expectedTaskCount = loadAgentTasks(resolveDefinitionsDir()).length;
      const firstCount = first.prepare(
        "SELECT COUNT(*) AS c FROM agent_tasks WHERE source = 'built-in'",
      ).get() as { c: number };
      expect(firstCount.c).toBe(expectedTaskCount);

      // Evict and re-open, simulating a fresh process opening a Grove DB
      // that was already seeded on a prior open (or, for a pre-existing
      // broken Grove, a DB the importer never touched).
      cache.evict(target);
      const second = cache.getDatabase(target);
      const secondCount = second.prepare(
        "SELECT COUNT(*) AS c FROM agent_tasks WHERE source = 'built-in'",
      ).get() as { c: number };
      expect(secondCount.c).toBe(expectedTaskCount);

      cache.closeAll();
    });

    it('short-circuits on a re-open of an already-seeded Grove DB: rows are not rewritten', () => {
      const cache = new GroveRuntimeCache();
      const target = emptyDbPath('short-circuit-grove');

      const first = cache.getDatabase(target);

      // Sentinel `updated_at` far in the past: the upsert path would
      // overwrite it with the current time, so an unchanged value proves
      // the short-circuit fired.
      const sentinel = 1;
      first.prepare('UPDATE agents SET updated_at = ? WHERE id = ?').run(sentinel, DEFAULT_AGENT_ID);

      // Evict (closes the handle, exactly as the cache's LRU eviction
      // would) and re-open through the cache — this re-runs
      // `openInitializedDatabase`, which re-invokes the seed on every
      // open.
      cache.evict(target);
      const second = cache.getDatabase(target);
      const stamp = second.prepare(
        'SELECT updated_at FROM agents WHERE id = ?',
      ).get(DEFAULT_AGENT_ID) as { updated_at: number };

      expect(stamp.updated_at).toBe(sentinel);

      cache.closeAll();
    });

    it('sweeps only source=built-in task rows when a built-in task is removed from YAML', () => {
      const cache = new GroveRuntimeCache();
      const target = emptyDbPath('sweep-grove');

      const db = cache.getDatabase(target);
      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        `INSERT INTO agent_tasks (id, agent_id, source, display_name, description, prompt, is_default, created_at, updated_at)
         VALUES (?, ?, 'built-in', 'Stale', 'stale', 'stale prompt', 0, ?, ?)`,
      ).run('removed-from-yaml', DEFAULT_AGENT_ID, now, now);
      db.prepare(
        `INSERT INTO agent_tasks (id, agent_id, source, display_name, description, prompt, is_default, created_at, updated_at)
         VALUES (?, ?, 'user', 'User Task', 'user', 'user prompt', 0, ?, ?)`,
      ).run('user-task-survives', DEFAULT_AGENT_ID, now, now);

      // Re-open (evict + getDatabase) to re-run the choke point's seed.
      cache.evict(target);
      const reopened = cache.getDatabase(target);

      const ids = (reopened.prepare('SELECT id, source FROM agent_tasks').all() as Array<{ id: string; source: string }>);
      expect(ids.some((r) => r.id === 'removed-from-yaml')).toBe(false);
      expect(ids.some((r) => r.id === 'user-task-survives' && r.source === 'user')).toBe(true);

      cache.closeAll();
    });

    it('re-seeds through the cache path when the stored content marker is stale (upgrade skew)', () => {
      const cache = new GroveRuntimeCache();
      const target = emptyDbPath('skew-grove');

      const db = cache.getDatabase(target);
      const current = db.prepare(
        "SELECT prompt FROM agent_tasks WHERE id = 'vault-evolve'",
      ).get() as { prompt: string };

      // Same task ids as the current definitions, but a stale prompt and a
      // marker hash that won't match — only the content marker check
      // forces the re-seed here, not the id-set check.
      db.prepare(
        "UPDATE agent_tasks SET prompt = 'stale prompt from an older binary' WHERE id = 'vault-evolve'",
      ).run();
      db.prepare('UPDATE agents SET config = ? WHERE id = ?').run(
        JSON.stringify({ definitions_hash: 'stale-hash-from-older-binary' }),
        DEFAULT_AGENT_ID,
      );

      cache.evict(target);
      const reopened = cache.getDatabase(target);

      const after = reopened.prepare(
        "SELECT prompt FROM agent_tasks WHERE id = 'vault-evolve'",
      ).get() as { prompt: string };
      expect(after.prompt).toBe(current.prompt);

      const config = (reopened.prepare('SELECT config FROM agents WHERE id = ?').get(DEFAULT_AGENT_ID) as {
        config: string | null;
      }).config;
      expect(config).not.toBeNull();
      const parsed = JSON.parse(config!) as { definitions_hash?: string };
      expect(parsed.definitions_hash).toBeDefined();
      expect(parsed.definitions_hash).not.toBe('stale-hash-from-older-binary');

      cache.closeAll();
    });

    it('regression pin: dispatch on a freshly created Grove no longer FK-fails on agent_runs.agent_id', () => {
      // Inserting an agent_runs row against a Grove DB opened through the
      // real cache path must not throw the agent_runs.agent_id ->
      // agents(id) FK violation.
      const cache = new GroveRuntimeCache();
      const fresh = emptyDbPath('dispatch-grove');
      const db = cache.getDatabase(fresh);

      const now = Math.floor(Date.now() / 1000);
      expect(() => {
        db.prepare(
          `INSERT INTO agent_runs (id, project_id, agent_id, task, status, started_at)
           VALUES (?, ?, ?, ?, 'running', ?)`,
        ).run('test-run-1', 'test-project', DEFAULT_AGENT_ID, 'vault-evolve', now);
      }).not.toThrow();

      const row = db.prepare('SELECT agent_id FROM agent_runs WHERE id = ?').get('test-run-1') as
        | { agent_id: string }
        | undefined;
      expect(row?.agent_id).toBe(DEFAULT_AGENT_ID);

      cache.closeAll();
    });
  });
});
