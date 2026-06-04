/**
 * Capture-pipeline HTTP end-to-end smoke test.
 *
 * `capture-pipeline-e2e.test.ts` starts at `createEventDispatcher` with a
 * pre-resolved request context and asserts against the in-memory test DB.
 * This test covers the layers the global symbiont-install migration actually
 * reshaped — and that the dispatcher-level test skips:
 *
 *   real DaemonClient → real HTTP transport → DaemonServer loopback/CSRF gate
 *   → bearer-token auth gate → server-side request-context resolution FROM
 *   HEADERS (manifest + registry) → per-Grove DB selection → real event
 *   dispatcher → a row in the Grove's SQLite file.
 *
 * It deliberately does NOT spawn the daemon as a subprocess — that is the
 * known daemon-spawn-and-wait flake class. The real `DaemonServer` runs
 * in-process on an ephemeral port and writes its own `daemon.json` (with
 * pid = this process, so the client treats it as a live daemon and never
 * forks one). The only links not exercised versus a live agent session are
 * the launcher shell script and binary resolution.
 *
 * Assertions read the Grove DB file the server actually wrote to (resolved
 * the same way production does), so this proves the event reached durable
 * SQLite — not just that the dispatcher returned ok. If this fails, an event
 * POSTed by a hook does not become a DB row: the "capture went dark" shape
 * behind #278/#284/#285/#286 and the May-2026 incident, over the HTTP path
 * the migration changed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { setupTestDb, teardownTestDb } from '../helpers/db';
import { makeTestRequestContext } from '../helpers/request-context';
import { createEventDispatcher } from '@myco/daemon/event-dispatch.js';
import { SessionRegistry } from '@myco/daemon/lifecycle.js';
import { PowerManager } from '@myco/daemon/power.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { DaemonServer } from '@myco/daemon/server.js';
import { DaemonClient } from '@myco/hooks/client.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';

describe('capture pipeline — HTTP end-to-end (client → server → Grove SQLite)', () => {
  let mycoHome: string;
  let vaultRoot: string;
  let vaultDir: string;
  let logDir: string;
  let savedMycoHome: string | undefined;
  let server: DaemonServer;
  let groveId: string;
  let projectId: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => {
    teardownTestDb();
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = savedMycoHome;
  });

  beforeEach(async () => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-http-e2e-'));
    mycoHome = path.join(vaultRoot, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    savedMycoHome ??= process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    vaultDir = path.join(vaultRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });

    // Provision the vault the way production does: a Grove record, a
    // grove-bound project.toml, and a registry entry whose projectId matches
    // the manifest. Server-side request-context resolution reads project.toml
    // from the vault, so a registry-only registration is not enough.
    const grove = createGrove('http-e2e', mycoHome);
    groveId = grove.id;
    const manifest = ensureProjectManifest(vaultDir, {
      projectName: 'http-e2e',
      groveId: grove.id,
      groveSlug: grove.slug,
      groveName: grove.name,
    });
    projectId = manifest.project.id;
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'http-e2e',
      projectRoot: vaultRoot,
      bindingId: manifest.grove?.binding_id,
    }, mycoHome);

    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-http-e2e-log-'));
    const logger = new DaemonLogger(logDir, { level: 'warn' });
    const registry = new SessionRegistry({ gracePeriod: 1, onEmpty: () => {} });
    const powerManager = new PowerManager({
      idleThresholdMs: 60_000,
      sleepThresholdMs: 120_000,
      deepSleepThresholdMs: 180_000,
      activeIntervalMs: 60_000,
      sleepIntervalMs: 60_000,
      logger,
      onTick: () => {},
      shouldHoldDeepSleep: () => false,
    });
    const dispatcher = createEventDispatcher({
      registry,
      sessionBuffers: new Map(),
      powerManager,
      logger,
      machineId: 'local',
      liveConfig: {
        current: {
          agent: { summary_batch_interval: 20 },
          canopy: { exclude: { patterns: [] } },
        } as never,
      },
      vaultDir,
      reconcileSession: () => {},
      planWatchConfig: { watchDirs: [], projectRoot: vaultDir },
      triggerTitleSummary: async () => {},
    });

    server = new DaemonServer({ vaultDir, logger });
    server.registerRoute('POST', '/events', dispatcher);
    // Ephemeral port; start() writes daemon.json (host/port/pid/auth_token)
    // at the MYCO_HOME service path the client reads from.
    await server.start(0);
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(vaultRoot, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  function makeClient(sessionId: string): DaemonClient {
    // Constructed AFTER start() so its default headers pick up the
    // daemon-issued bearer token from daemon.json. The grove-bound context
    // makes it emit the request-context headers the server resolves.
    const ctx = makeTestRequestContext({ vaultDir, groveId, projectId, sessionId });
    return new DaemonClient(vaultDir, { requestContext: ctx });
  }

  /** Open the Grove DB the server wrote to and run a query. Read-only; the
   *  server's own connection stays open in the runtime cache. */
  function queryGroveDb<T>(fn: (db: Database) => T): T {
    const db = new Database(resolveGroveDbPath(groveId, mycoHome), { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  it('a hook POST becomes a session + batch + activity in the Grove SQLite', async () => {
    const sessionId = 'http-e2e-session-001';
    const client = makeClient(sessionId);

    const r1 = await client.capturePost('/events', {
      type: 'user_prompt',
      session_id: sessionId,
      agent: 'claude-code',
      prompt: 'Write a hello world program',
      transcript_path: '/tmp/fake-transcript.jsonl',
    });
    expect(r1.ok).toBe(true);

    const r2 = await client.capturePost('/events', {
      type: 'tool_use',
      session_id: sessionId,
      agent: 'claude-code',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/hello.ts', content: 'console.log("hi")' },
      transcript_path: '/tmp/fake-transcript.jsonl',
    });
    expect(r2.ok).toBe(true);

    // The event traveled client → HTTP → server routing → request-context
    // resolution → per-Grove DB selection → dispatcher → SQLite. Read the
    // Grove DB file directly to prove it landed durably.
    const session = queryGroveDb((db) =>
      db.prepare('SELECT id, status FROM sessions WHERE id = ?').get(sessionId) as
        { id: string; status: string } | null,
    );
    expect(session).not.toBeNull();
    expect(session!.id).toBe(sessionId);

    const batches = queryGroveDb((db) =>
      db.prepare('SELECT id, prompt_number, user_prompt FROM prompt_batches WHERE session_id = ? ORDER BY prompt_number').all(sessionId) as
        Array<{ id: number; prompt_number: number; user_prompt: string }>,
    );
    expect(batches.length).toBe(1);
    expect(batches[0].user_prompt).toBe('Write a hello world program');

    const activities = queryGroveDb((db) =>
      db.prepare('SELECT tool_name, prompt_batch_id FROM activities WHERE session_id = ?').all(sessionId) as
        Array<{ tool_name: string; prompt_batch_id: number }>,
    );
    expect(activities.length).toBe(1);
    expect(activities[0].tool_name).toBe('Write');
    expect(activities[0].prompt_batch_id).toBe(batches[0].id);
  });

  it('a second turn opens batch #2 over the same HTTP client', async () => {
    const sessionId = 'http-e2e-session-002';
    const client = makeClient(sessionId);

    for (const prompt of ['first prompt', 'second prompt']) {
      const res = await client.capturePost('/events', {
        type: 'user_prompt',
        session_id: sessionId,
        agent: 'claude-code',
        prompt,
        transcript_path: '/tmp/fake-transcript.jsonl',
      });
      expect(res.ok).toBe(true);
    }

    const batches = queryGroveDb((db) =>
      db.prepare('SELECT prompt_number, user_prompt FROM prompt_batches WHERE session_id = ? ORDER BY prompt_number').all(sessionId) as
        Array<{ prompt_number: number; user_prompt: string }>,
    );
    expect(batches.map((b) => b.prompt_number)).toEqual([1, 2]);
    expect(batches.map((b) => b.user_prompt)).toEqual(['first prompt', 'second prompt']);
  });
});
