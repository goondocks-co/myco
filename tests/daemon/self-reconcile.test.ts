import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileSelf } from '../../packages/myco/src/daemon/self-reconcile.js';
import {
  writeRestartIntent,
} from '../../packages/myco/src/daemon/intent.js';
import type {
  DaemonServiceState,
  DaemonState,
  DaemonStatePath,
} from '../../packages/myco/src/daemon/service-state.js';
import {
  createDaemonStateAuthority,
  type DaemonStateAuthority,
} from '../../packages/myco/src/daemon/daemon-state-authority.js';
import type { DaemonLogger } from '../../packages/myco/src/daemon/logger.js';

function makeAuthority(daemonService: DaemonServiceState): DaemonStateAuthority {
  return createDaemonStateAuthority(daemonService, { info: () => {} });
}

const RESTART_INTENT_FILE = 'intent.restart.toml';

function makeLogger(): DaemonLogger & { calls: { kind: string; message: string }[] } {
  const calls: { kind: string; message: string }[] = [];
  const logger = {
    calls,
    debug() {},
    info(kind: string, message: string) { calls.push({ kind, message }); },
    warn() {},
    error() {},
  } as unknown as DaemonLogger & { calls: { kind: string; message: string }[] };
  return logger;
}

function makeDaemonService(dir: string): DaemonServiceState {
  return {
    scope: 'global',
    stateDir: dir,
    // Tests construct DaemonServiceState directly; the brand on
    // statePath documents that mutations should flow through the
    // authority (which we wire via `makeAuthority` above).
    statePath: join(dir, 'daemon.json') as DaemonStatePath,
    lockPath: join(dir, 'daemon.lock'),
    canonicalPort: 20915,
  };
}

function makeState(): DaemonState {
  return {
    pid: process.pid,
    port: 20915,
    command: process.execPath,
    started: new Date().toISOString(),
    sessions: [],
    version: '0.27.10',
    auth_token: 'tok-deadbeef',
  };
}

describe('reconcileSelf', () => {
  test('writes daemon.json when the file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-missing-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    expect(existsSync(daemonService.statePath)).toBe(false);
    await reconcileSelf({ daemonService, stateAuthority: makeAuthority(daemonService), currentState: () => state, logger });
    expect(existsSync(daemonService.statePath)).toBe(true);

    const parsed = JSON.parse(readFileSync(daemonService.statePath, 'utf-8'));
    expect(parsed.pid).toBe(state.pid);
    expect(parsed.port).toBe(state.port);
    expect(parsed.auth_token).toBe(state.auth_token);
    expect(logger.calls.some((c) => c.kind === 'daemon.reconcile')).toBe(true);
  });

  test('re-writes daemon.json after it has been deleted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-deleted-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    await reconcileSelf({ daemonService, stateAuthority: makeAuthority(daemonService), currentState: () => state, logger });
    expect(existsSync(daemonService.statePath)).toBe(true);

    unlinkSync(daemonService.statePath);
    expect(existsSync(daemonService.statePath)).toBe(false);

    await reconcileSelf({ daemonService, stateAuthority: makeAuthority(daemonService), currentState: () => state, logger });
    expect(existsSync(daemonService.statePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(daemonService.statePath, 'utf-8'));
    expect(parsed.pid).toBe(process.pid);
  });

  test('refreshes mtime when state matches expected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-mtime-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    await reconcileSelf({ daemonService, stateAuthority: makeAuthority(daemonService), currentState: () => state, logger });
    const mtime1 = statSync(daemonService.statePath).mtimeMs;

    await new Promise((r) => setTimeout(r, 1100));

    await reconcileSelf({ daemonService, stateAuthority: makeAuthority(daemonService), currentState: () => state, logger });
    const mtime2 = statSync(daemonService.statePath).mtimeMs;
    expect(mtime2).toBeGreaterThan(mtime1);

    const discrepancyLogs = logger.calls.filter((c) => c.kind === 'daemon.reconcile');
    expect(discrepancyLogs.length).toBeLessThanOrEqual(1);
  });

  test('consumes restart intent and invokes supervisor restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-intent-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    writeRestartIntent(daemonService, {
      requested_at: new Date().toISOString(),
      reason: 'test',
    });
    expect(existsSync(join(dir, RESTART_INTENT_FILE))).toBe(true);

    let restartCalls = 0;
    await reconcileSelf({
      daemonService,
      stateAuthority: makeAuthority(daemonService),
      currentState: () => state,
      logger,
      requestSupervisorRestart: () => { restartCalls += 1; },
    });

    expect(restartCalls).toBe(1);
    expect(existsSync(join(dir, RESTART_INTENT_FILE))).toBe(false);
    expect(logger.calls.some((c) => c.message.includes('Restart intent observed'))).toBe(true);
  });

  test('clears restart intent BEFORE invoking supervisor restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-intent-order-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    writeRestartIntent(daemonService, {
      requested_at: new Date().toISOString(),
      reason: 'test',
    });

    // Throwing inside requestSupervisorRestart simulates a supervisor
    // invocation failure. The intent MUST already be cleared by the
    // time we throw — otherwise a respawn loop would re-trigger the
    // same restart on the next tick.
    let intentClearedAtThrowTime: boolean | null = null;
    await expect(
      reconcileSelf({
        daemonService,
        stateAuthority: makeAuthority(daemonService),
        currentState: () => state,
        logger,
        requestSupervisorRestart: () => {
          intentClearedAtThrowTime = !existsSync(join(dir, RESTART_INTENT_FILE));
          throw new Error('supervisor failed');
        },
      }),
    ).rejects.toThrow('supervisor failed');

    expect(intentClearedAtThrowTime).toBe(true);
  });

  test('does nothing when no intent files exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-no-intent-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    let restartCalls = 0;
    await reconcileSelf({
      daemonService,
      stateAuthority: makeAuthority(daemonService),
      currentState: () => state,
      logger,
      requestSupervisorRestart: () => { restartCalls += 1; },
    });

    expect(restartCalls).toBe(0);
  });

  test('ignores a malformed intent file without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-bad-intent-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    writeFileSync(join(dir, RESTART_INTENT_FILE), 'this is not = valid = toml = at all');

    let restartCalls = 0;
    await expect(
      reconcileSelf({
        daemonService,
        stateAuthority: makeAuthority(daemonService),
        currentState: () => state,
        logger,
        requestSupervisorRestart: () => { restartCalls += 1; },
      }),
    ).resolves.toBeUndefined();
    expect(restartCalls).toBe(0);
  });

  test('does not require requestSupervisorRestart dep (clears intent and continues)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-no-spy-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    writeRestartIntent(daemonService, {
      requested_at: new Date().toISOString(),
      reason: 'test',
    });

    await expect(reconcileSelf({ daemonService, stateAuthority: makeAuthority(daemonService), currentState: () => state, logger })).resolves.toBeUndefined();
    expect(existsSync(join(dir, RESTART_INTENT_FILE))).toBe(false);
  });

  test('overwrites daemon.json when it points to a different pid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-foreign-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    const foreign: DaemonState = { ...state, pid: state.pid + 99999 };
    await reconcileSelf({ daemonService, stateAuthority: makeAuthority(daemonService), currentState: () => foreign, logger });
    const foreignWrite = JSON.parse(readFileSync(daemonService.statePath, 'utf-8'));
    expect(foreignWrite.pid).toBe(foreign.pid);

    await reconcileSelf({ daemonService, stateAuthority: makeAuthority(daemonService), currentState: () => state, logger });
    const final = JSON.parse(readFileSync(daemonService.statePath, 'utf-8'));
    expect(final.pid).toBe(state.pid);
    expect(logger.calls.some((c) => c.message.includes('Re-asserting'))).toBe(true);
  });

  test('self-reconcile does not dispatch a binary update — update intent is no longer drained', async () => {
    // Regression guard: writing an intent.update.toml file (e.g. leftover
    // from a pre-Task-9 state dir) must NOT trigger any installer call.
    // reconcileSelf only drains [restart] now.
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-no-update-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    // Write a stale update intent file directly (bypass the removed API).
    const { join: pathJoin } = await import('node:path');
    const { writeFileSync: wfs } = await import('node:fs');
    wfs(
      pathJoin(dir, 'intent.update.toml'),
      'target_version = "9.9.9"\nrequested_at = "2026-06-01T00:00:00Z"\n',
    );

    let restartCalls = 0;
    await reconcileSelf({
      daemonService,
      stateAuthority: makeAuthority(daemonService),
      currentState: () => state,
      logger,
      requestSupervisorRestart: () => { restartCalls += 1; },
    });

    // No restart triggered (the file only contained an update intent).
    expect(restartCalls).toBe(0);
    // The stale file is left untouched (reconcileSelf no longer reads it).
    expect(existsSync(pathJoin(dir, 'intent.update.toml'))).toBe(true);
    // No update-related log line.
    expect(logger.calls.some((c) => c.message.toLowerCase().includes('update'))).toBe(false);
  });
});
