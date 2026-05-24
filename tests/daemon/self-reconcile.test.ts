import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileSelf } from '../../packages/myco/src/daemon/self-reconcile.js';
import {
  writeRefreshLaunchersIntent,
  writeRestartIntent,
  writeUpdateIntent,
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
const UPDATE_INTENT_FILE = 'intent.update.toml';

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

function makeErrorLogger(): DaemonLogger & {
  calls: { kind: string; message: string; level: 'info' | 'error' }[];
} {
  const calls: { kind: string; message: string; level: 'info' | 'error' }[] = [];
  const logger = {
    calls,
    debug() {},
    info(kind: string, message: string) { calls.push({ kind, message, level: 'info' }); },
    warn() {},
    error(kind: string, message: string) { calls.push({ kind, message, level: 'error' }); },
  } as unknown as DaemonLogger & { calls: typeof calls };
  return logger;
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

  test('refresh-launchers intent invokes the refresh callback and clears the intent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-refresh-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();
    const REFRESH_FILE = 'intent.refresh-launchers.toml';

    writeRefreshLaunchersIntent(daemonService, {
      requested_at: new Date().toISOString(),
      reason: 'version-drift',
    });
    expect(existsSync(join(dir, REFRESH_FILE))).toBe(true);

    let refreshes = 0;
    await reconcileSelf({
      daemonService,
      stateAuthority: makeAuthority(daemonService),
      currentState: () => state,
      logger,
      refreshLaunchers: () => { refreshes++; },
    });

    expect(refreshes).toBe(1);
    expect(existsSync(join(dir, REFRESH_FILE))).toBe(false);
    expect(logger.calls.some((c) => c.message.includes('Refresh-launchers intent observed'))).toBe(true);
  });

  test('refresh-launchers intent retained when the refresh callback throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-refresh-fail-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeErrorLogger();
    const REFRESH_FILE = 'intent.refresh-launchers.toml';

    writeRefreshLaunchersIntent(daemonService, {
      requested_at: new Date().toISOString(),
    });

    await reconcileSelf({
      daemonService,
      stateAuthority: makeAuthority(daemonService),
      currentState: () => state,
      logger,
      refreshLaunchers: () => { throw new Error('disk full'); },
    });

    expect(existsSync(join(dir, REFRESH_FILE))).toBe(true);
    expect(logger.calls.some((c) => c.level === 'error' && c.message.includes('Launcher refresh failed'))).toBe(true);
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
});

describe('reconcileSelf update intent', () => {
  test('invokes installUpdate and RETAINS intent across the spawn (post-restart daemon decides)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-update-spawn-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    writeUpdateIntent(daemonService, {
      target_version: '0.27.99',
      requested_at: new Date().toISOString(),
    });
    expect(existsSync(join(dir, UPDATE_INTENT_FILE))).toBe(true);

    const installerCalls: string[] = [];
    await reconcileSelf({
      daemonService,
      stateAuthority: makeAuthority(daemonService),
      currentState: () => state,
      logger,
      installUpdate: async (target) => { installerCalls.push(target); },
    });

    expect(installerCalls).toEqual(['0.27.99']);
    // Intent is retained: the installer script is detached and the post-
    // restart daemon decides based on version match + update-error.json.
    // Clearing here would defeat the retry semantics on install failure.
    expect(existsSync(join(dir, UPDATE_INTENT_FILE))).toBe(true);
    expect(logger.calls.some((c) => c.message.includes('Update intent observed'))).toBe(true);
  });

  test('skips installUpdate and stays silent when updateInFlight reports an in-flight installer', async () => {
    // Real failure mode: `/api/update/apply` writes the in-progress
    // sentinel and spawns the installer; the next reconciler tick
    // observes the still-present intent file and would re-spawn a
    // second installer without this gate. We assert no installUpdate
    // call, no "Update intent observed" log noise, and that the
    // intent file is retained (the post-restart tick decides).
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-update-inflight-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    writeUpdateIntent(daemonService, {
      target_version: '0.27.99',
      requested_at: new Date().toISOString(),
    });

    let installerCalls = 0;
    await reconcileSelf({
      daemonService,
      stateAuthority: makeAuthority(daemonService),
      currentState: () => state,
      logger,
      installUpdate: async () => { installerCalls += 1; },
      updateInFlight: () => true,
    });

    expect(installerCalls).toBe(0);
    expect(existsSync(join(dir, UPDATE_INTENT_FILE))).toBe(true);
    expect(logger.calls.some((c) => c.message.includes('Update intent observed'))).toBe(false);
  });

  test('clears intent when current version matches target (post-restart success path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-update-success-'));
    const daemonService = makeDaemonService(dir);
    const state: DaemonState = { ...makeState(), version: '0.27.99' };
    const logger = makeLogger();

    writeUpdateIntent(daemonService, {
      target_version: '0.27.99',
      requested_at: new Date().toISOString(),
    });

    let installerCalls = 0;
    await reconcileSelf({
      daemonService,
      stateAuthority: makeAuthority(daemonService),
      currentState: () => state,
      logger,
      installUpdate: async () => { installerCalls += 1; },
    });

    expect(installerCalls).toBe(0);
    expect(existsSync(join(dir, UPDATE_INTENT_FILE))).toBe(false);
  });

  test('clears intent and surfaces error when update-error.json is present (failure path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-update-failure-'));
    const daemonService = makeDaemonService(dir);
    // Version mismatch — install did not move the binary to target.
    const state: DaemonState = { ...makeState(), version: '0.27.10' };
    const logger = makeErrorLogger();

    writeUpdateIntent(daemonService, {
      target_version: '0.27.99',
      requested_at: new Date().toISOString(),
    });

    let installerCalls = 0;
    let consumed = 0;
    await reconcileSelf({
      daemonService,
      stateAuthority: makeAuthority(daemonService),
      currentState: () => state,
      logger,
      installUpdate: async () => { installerCalls += 1; },
      readUpdateError: () => 'npm install failed for @goondocks/myco@0.27.99',
      consumeUpdateError: () => { consumed += 1; },
    });

    // Installer must NOT have been re-invoked — that would be the
    // infinite-retry bug. Surface the prior failure to the user instead.
    expect(installerCalls).toBe(0);
    expect(existsSync(join(dir, UPDATE_INTENT_FILE))).toBe(false);
    expect(consumed).toBe(1);
    expect(
      logger.calls.some(
        (c) => c.level === 'error' && c.message.includes('Update failed during a prior attempt'),
      ),
    ).toBe(true);
  });

  test('retains intent and logs error on synchronous installer throw (next-tick retry)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-update-sync-fail-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeErrorLogger();

    writeUpdateIntent(daemonService, {
      target_version: '0.27.99',
      requested_at: new Date().toISOString(),
    });

    let installerCalls = 0;
    await reconcileSelf({
      daemonService,
      stateAuthority: makeAuthority(daemonService),
      currentState: () => state,
      logger,
      installUpdate: async () => {
        installerCalls += 1;
        throw new Error('mkdir tmp failed (transient)');
      },
      readUpdateError: () => null,
    });

    expect(installerCalls).toBe(1);
    // Intent file MUST still be present so the next tick retries — a
    // sync-spawn failure is typically transient (filesystem hiccup) and
    // a retry will likely succeed.
    expect(existsSync(join(dir, UPDATE_INTENT_FILE))).toBe(true);
    expect(
      logger.calls.some(
        (c) => c.level === 'error' && c.message.includes('Update spawn failed synchronously'),
      ),
    ).toBe(true);
  });

  test('does nothing when installUpdate dep is omitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-update-no-dep-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    writeUpdateIntent(daemonService, {
      target_version: '0.27.99',
      requested_at: new Date().toISOString(),
    });

    await expect(
      reconcileSelf({ daemonService, stateAuthority: makeAuthority(daemonService), currentState: () => state, logger }),
    ).resolves.toBeUndefined();

    expect(existsSync(join(dir, UPDATE_INTENT_FILE))).toBe(true);
  });
});
