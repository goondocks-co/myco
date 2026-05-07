import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Database } from 'bun:sqlite';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema';
import {
  CanopyDeltaScanRunner,
  CanopyJobsRegistry,
  CanopyBackgroundScanDispatcher,
  CANOPY_DELTA_DEBOUNCE_MS,
  type CanopyRunnerSharedDeps,
} from '@myco/daemon/jobs/canopy-scan';
import type { GroveProjectId } from '@myco/grove/ids';

function buildLogger() {
  const calls: Array<{ level: string; kind: string; msg: string; meta?: unknown }> = [];
  const logger = {
    info: (kind: string, msg: string, meta?: unknown) => calls.push({ level: 'info', kind, msg, meta }),
    warn: (kind: string, msg: string, meta?: unknown) => calls.push({ level: 'warn', kind, msg, meta }),
    error: (kind: string, msg: string, meta?: unknown) => calls.push({ level: 'error', kind, msg, meta }),
    debug: (kind: string, msg: string, meta?: unknown) => calls.push({ level: 'debug', kind, msg, meta }),
  };
  // The real DaemonLogger has more methods — the jobs only use info/warn/error.
  return { logger: logger as unknown as import('@myco/daemon/logger').DaemonLogger, calls };
}

let tmp: string;
let projectRoot: string;
let dbPath: string;
const liveConfig: { current: MycoConfig } = {
  current: MycoConfigSchema.parse({ version: 3 }),
};

const PROJECT_ID = ('proj_' + '0123456789abcdef'.repeat(2)) as GroveProjectId;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-canopy-jobs-'));
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  dbPath = path.join(tmp, 'myco.db');
  initDatabase(dbPath);
  createSchema(getDatabase());
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const abs = path.join(projectRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function buildShared(overrides: Partial<CanopyRunnerSharedDeps> = {}): {
  shared: CanopyRunnerSharedDeps;
  calls: ReturnType<typeof buildLogger>['calls'];
} {
  const { logger, calls } = buildLogger();
  const shared: CanopyRunnerSharedDeps = {
    logger,
    machineId: 'local',
    liveConfig,
    resolveDb: () => getDatabase(),
    ...overrides,
  };
  return { shared, calls };
}

describe('CanopyJobsRegistry.runFullScan', () => {
  it('logs CANOPY_SCAN on success', async () => {
    write('a.ts', 'export const a = 1;\n');
    const { shared, calls } = buildShared();
    const registry = new CanopyJobsRegistry(shared);
    await registry.runFullScan({ databasePath: dbPath, projectId: PROJECT_ID, projectRoot });
    expect(calls.some((c) => c.kind === 'canopy.scan' && c.level === 'info')).toBe(true);
  });
});

describe('CanopyJobsRegistry.initialPopulate', () => {
  it('skips the full scan when rows already exist', async () => {
    write('a.ts', 'export const a = 1;\n');
    const { shared, calls } = buildShared();
    const registry = new CanopyJobsRegistry(shared);
    const identity = { databasePath: dbPath, projectId: PROJECT_ID, projectRoot };
    await registry.runFullScan(identity);
    calls.length = 0;
    await registry.initialPopulate(identity);
    expect(calls.some((c) => c.kind === 'canopy.scan')).toBe(false);
  });
});

describe('CanopyDeltaScanRunner', () => {
  it('debounces back-to-back triggers within the window', async () => {
    write('a.ts', 'export const a = 1;\n');
    const { shared, calls } = buildShared();
    const runner = new CanopyDeltaScanRunner(
      { databasePath: dbPath, projectId: PROJECT_ID, projectRoot },
      shared,
    );
    await runner.run(1_000);
    await runner.run(1_000 + CANOPY_DELTA_DEBOUNCE_MS - 1);
    const runs = calls.filter((c) => c.kind === 'canopy.scan').length;
    expect(runs).toBe(1);
  });

  it('runs again after the debounce window elapses', async () => {
    write('a.ts', 'export const a = 1;\n');
    const { shared, calls } = buildShared();
    const runner = new CanopyDeltaScanRunner(
      { databasePath: dbPath, projectId: PROJECT_ID, projectRoot },
      shared,
    );
    await runner.run(1_000);
    await runner.run(1_000 + CANOPY_DELTA_DEBOUNCE_MS + 1);
    const runs = calls.filter((c) => c.kind === 'canopy.scan').length;
    expect(runs).toBe(2);
  });

  it('re-resolves the DB on each execute (cache eviction tolerant)', async () => {
    write('a.ts', 'export const a = 1;\n');
    let resolves = 0;
    const { shared } = buildShared({
      resolveDb: () => {
        resolves += 1;
        return getDatabase();
      },
    });
    const runner = new CanopyDeltaScanRunner(
      { databasePath: dbPath, projectId: PROJECT_ID, projectRoot },
      shared,
    );
    await runner.run(1_000);
    await runner.run(1_000 + CANOPY_DELTA_DEBOUNCE_MS + 1);
    expect(resolves).toBeGreaterThanOrEqual(2);
  });
});

describe('CanopyBackgroundScanDispatcher', () => {
  it('respects the configured period', async () => {
    let dispatched = 0;
    const cfg = { current: MycoConfigSchema.parse({
      version: 3,
      cortex: { canopy: { refresh: { background_period_minutes: 1 } } },
    }) } as { current: MycoConfig };
    const { logger } = buildLogger();
    const registry = new CanopyJobsRegistry({
      logger,
      machineId: 'local',
      liveConfig: cfg,
      resolveDb: () => getDatabase(),
    });
    const dispatcher = new CanopyBackgroundScanDispatcher(cfg, logger, async () => {
      dispatched += 1;
    });
    await dispatcher.tick();
    await dispatcher.tick(); // immediately — should be skipped by the period gate
    expect(dispatched).toBe(1);
    // Touch registry so the unused-binding check stays clean.
    expect(registry.getRunner(PROJECT_ID)).toBeUndefined();
  });

  it('skips entirely when background_enabled is false', async () => {
    let dispatched = 0;
    const cfg = { current: MycoConfigSchema.parse({
      version: 3,
      cortex: { canopy: { refresh: { background_enabled: false } } },
    }) } as { current: MycoConfig };
    const { logger } = buildLogger();
    const dispatcher = new CanopyBackgroundScanDispatcher(cfg, logger, async () => {
      dispatched += 1;
    });
    await dispatcher.tick();
    expect(dispatched).toBe(0);
  });
});

describe('mass-add kick', () => {
  it('runFullScan calls onCanopyMassAdd when added > threshold', async () => {
    // Threshold is 10. Write 12 files so the populate adds 12 > 10.
    for (let i = 0; i < 12; i++) write(`f${i}.ts`, `export const x${i} = ${i};\n`);
    let kicks = 0;
    const { shared } = buildShared({ onCanopyMassAdd: () => { kicks += 1; } });
    const registry = new CanopyJobsRegistry(shared);
    await registry.runFullScan({ databasePath: dbPath, projectId: PROJECT_ID, projectRoot });
    expect(kicks).toBe(1);
  });

  it('runFullScan does NOT kick when added is small (steady churn)', async () => {
    for (let i = 0; i < 3; i++) write(`f${i}.ts`, `export const x${i} = ${i};\n`);
    let kicks = 0;
    const { shared } = buildShared({ onCanopyMassAdd: () => { kicks += 1; } });
    const registry = new CanopyJobsRegistry(shared);
    await registry.runFullScan({ databasePath: dbPath, projectId: PROJECT_ID, projectRoot });
    expect(kicks).toBe(0);
  });

  it('initialPopulate kicks via onCanopyMassAdd on a fresh vault', async () => {
    for (let i = 0; i < 15; i++) write(`f${i}.ts`, `export const x${i} = ${i};\n`);
    let kicks = 0;
    const { shared } = buildShared({ onCanopyMassAdd: () => { kicks += 1; } });
    const registry = new CanopyJobsRegistry(shared);
    await registry.initialPopulate({ databasePath: dbPath, projectId: PROJECT_ID, projectRoot });
    expect(kicks).toBe(1);
  });

  it('CanopyDeltaScanRunner kicks via onCanopyMassAdd when delta scan adds many rows', async () => {
    for (let i = 0; i < 12; i++) write(`f${i}.ts`, `export const x${i} = ${i};\n`);
    let kicks = 0;
    const { shared } = buildShared({ onCanopyMassAdd: () => { kicks += 1; } });
    const runner = new CanopyDeltaScanRunner(
      { databasePath: dbPath, projectId: PROJECT_ID, projectRoot },
      shared,
    );
    await runner.run();
    // Drain the microtask queue used by setTimeout(0) inside execute().
    await new Promise((r) => setTimeout(r, 5));
    expect(kicks).toBe(1);
  });
});

describe('CanopyJobsRegistry.ensureRunner', () => {
  it('returns the same runner instance per projectId', () => {
    const { shared } = buildShared();
    const registry = new CanopyJobsRegistry(shared);
    const a = registry.ensureRunner({ databasePath: dbPath, projectId: PROJECT_ID, projectRoot });
    const b = registry.ensureRunner({ databasePath: dbPath, projectId: PROJECT_ID, projectRoot });
    expect(a).toBe(b);
  });

  it('returns distinct runners for different projects', () => {
    const { shared } = buildShared();
    const registry = new CanopyJobsRegistry(shared);
    const a = registry.ensureRunner({ databasePath: dbPath, projectId: PROJECT_ID, projectRoot });
    const otherId = ('proj_' + 'fedcba9876543210'.repeat(2)) as GroveProjectId;
    const b = registry.ensureRunner({ databasePath: dbPath, projectId: otherId, projectRoot });
    expect(a).not.toBe(b);
    expect(registry.getRunner(PROJECT_ID)).toBe(a);
    expect(registry.getRunner(otherId)).toBe(b);
  });
});
