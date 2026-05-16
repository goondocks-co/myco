import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileSelf } from '../../packages/myco/src/daemon/self-reconcile.js';
import { mergeIntent } from '../../packages/myco/src/daemon/intent.js';
import type {
  DaemonServiceState,
  DaemonState,
} from '../../packages/myco/src/daemon/service-state.js';
import type { DaemonLogger } from '../../packages/myco/src/daemon/logger.js';

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
    statePath: join(dir, 'daemon.json'),
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
  test('writes daemon.json when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-missing-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    expect(existsSync(daemonService.statePath)).toBe(false);
    reconcileSelf({ daemonService, currentState: () => state, logger });
    expect(existsSync(daemonService.statePath)).toBe(true);

    const parsed = JSON.parse(readFileSync(daemonService.statePath, 'utf-8'));
    expect(parsed.pid).toBe(state.pid);
    expect(parsed.port).toBe(state.port);
    expect(parsed.auth_token).toBe(state.auth_token);
    // Missing file => the discrepancy path logs the re-assertion.
    expect(logger.calls.some((c) => c.kind === 'daemon.reconcile')).toBe(true);
  });

  test('re-writes daemon.json after it has been deleted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-deleted-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    reconcileSelf({ daemonService, currentState: () => state, logger });
    expect(existsSync(daemonService.statePath)).toBe(true);

    unlinkSync(daemonService.statePath);
    expect(existsSync(daemonService.statePath)).toBe(false);

    reconcileSelf({ daemonService, currentState: () => state, logger });
    expect(existsSync(daemonService.statePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(daemonService.statePath, 'utf-8'));
    expect(parsed.pid).toBe(process.pid);
  });

  test('refreshes mtime when state matches expected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-mtime-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    reconcileSelf({ daemonService, currentState: () => state, logger });
    const mtime1 = statSync(daemonService.statePath).mtimeMs;

    // Give the filesystem mtime granularity headroom; HFS+ and some
    // network FS only resolve to whole seconds.
    await new Promise((r) => setTimeout(r, 1100));

    reconcileSelf({ daemonService, currentState: () => state, logger });
    const mtime2 = statSync(daemonService.statePath).mtimeMs;
    expect(mtime2).toBeGreaterThan(mtime1);

    // No discrepancy means no daemon.reconcile log entries beyond
    // (potentially) the first write.
    const discrepancyLogs = logger.calls.filter((c) => c.kind === 'daemon.reconcile');
    expect(discrepancyLogs.length).toBeLessThanOrEqual(1);
  });

  test('consumes restart intent and invokes supervisor restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-intent-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    mergeIntent(daemonService, {
      restart: { requested_at: new Date().toISOString(), reason: 'test' },
    });
    expect(existsSync(join(dir, 'intent.toml'))).toBe(true);

    let restartCalls = 0;
    reconcileSelf({
      daemonService,
      currentState: () => state,
      logger,
      requestSupervisorRestart: () => { restartCalls += 1; },
    });

    expect(restartCalls).toBe(1);
    // clearIntentSection removes the file when no sections remain.
    expect(existsSync(join(dir, 'intent.toml'))).toBe(false);
    expect(logger.calls.some((c) => c.message.includes('Restart intent observed'))).toBe(true);
  });

  test('clears restart intent BEFORE invoking supervisor restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-intent-order-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    mergeIntent(daemonService, {
      restart: { requested_at: new Date().toISOString(), reason: 'test' },
    });

    // Throwing inside requestSupervisorRestart simulates a supervisor
    // invocation failure. The intent MUST already be cleared by the
    // time we throw — otherwise a respawn loop would re-trigger the
    // same restart on the next tick.
    let intentClearedAtThrowTime: boolean | null = null;
    expect(() =>
      reconcileSelf({
        daemonService,
        currentState: () => state,
        logger,
        requestSupervisorRestart: () => {
          intentClearedAtThrowTime = !existsSync(join(dir, 'intent.toml'));
          throw new Error('supervisor failed');
        },
      }),
    ).toThrow('supervisor failed');

    expect(intentClearedAtThrowTime).toBe(true);
  });

  test('does nothing when intent.toml is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-no-intent-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    let restartCalls = 0;
    reconcileSelf({
      daemonService,
      currentState: () => state,
      logger,
      requestSupervisorRestart: () => { restartCalls += 1; },
    });

    expect(restartCalls).toBe(0);
  });

  test('ignores a malformed intent.toml without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-bad-intent-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    writeFileSync(join(dir, 'intent.toml'), 'this is not = valid = toml = at all');

    let restartCalls = 0;
    expect(() =>
      reconcileSelf({
        daemonService,
        currentState: () => state,
        logger,
        requestSupervisorRestart: () => { restartCalls += 1; },
      }),
    ).not.toThrow();
    expect(restartCalls).toBe(0);
  });

  test('does not require requestSupervisorRestart dep (clears intent and continues)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-no-spy-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    mergeIntent(daemonService, {
      restart: { requested_at: new Date().toISOString(), reason: 'test' },
    });

    expect(() => reconcileSelf({ daemonService, currentState: () => state, logger })).not.toThrow();
    // Intent still gets cleared even without the supervisor dep.
    expect(existsSync(join(dir, 'intent.toml'))).toBe(false);
  });

  test('overwrites daemon.json when it points to a different pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-recon-foreign-'));
    const daemonService = makeDaemonService(dir);
    const state = makeState();
    const logger = makeLogger();

    // Seed with foreign pid (some other process claimed the file).
    const foreign: DaemonState = { ...state, pid: state.pid + 99999 };
    reconcileSelf({ daemonService, currentState: () => foreign, logger });
    const foreignWrite = JSON.parse(readFileSync(daemonService.statePath, 'utf-8'));
    expect(foreignWrite.pid).toBe(foreign.pid);

    // Reconcile under our identity; we must re-assert.
    reconcileSelf({ daemonService, currentState: () => state, logger });
    const final = JSON.parse(readFileSync(daemonService.statePath, 'utf-8'));
    expect(final.pid).toBe(state.pid);
    expect(logger.calls.some((c) => c.message.includes('Re-asserting'))).toBe(true);
  });
});
