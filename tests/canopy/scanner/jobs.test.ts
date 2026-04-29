import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { MycoConfigSchema } from '@myco/config/schema';
import { runCanopyScan, runInitialCanopyPopulate } from '@myco/daemon/jobs/canopy-scan';
import {
  CanopyDeltaScanRunner,
  CANOPY_DELTA_DEBOUNCE_MS,
} from '@myco/daemon/jobs/canopy-delta-scan';
import { CanopyBackgroundScan } from '@myco/daemon/jobs/canopy-background-scan';

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
const liveConfig = { current: MycoConfigSchema.parse({ version: 3 }) };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-canopy-jobs-'));
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  initDatabase(path.join(tmp, 'myco.db'));
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

describe('runCanopyScan', () => {
  it('logs CANOPY_SCAN on success', async () => {
    write('a.ts', 'export const a = 1;\n');
    const { logger, calls } = buildLogger();
    await runCanopyScan({
      db: getDatabase(),
      logger,
      machineId: 'local',
      projectRoot,
      projectId: projectRoot,
      liveConfig,
    });
    expect(calls.some((c) => c.kind === 'canopy.scan' && c.level === 'info')).toBe(true);
  });

  it('initial populate skips the full scan when rows already exist', async () => {
    write('a.ts', 'export const a = 1;\n');
    const { logger, calls } = buildLogger();
    await runCanopyScan({
      db: getDatabase(),
      logger,
      machineId: 'local',
      projectRoot,
      projectId: projectRoot,
      liveConfig,
    });
    calls.length = 0;

    await runInitialCanopyPopulate({
      db: getDatabase(),
      logger,
      machineId: 'local',
      projectRoot,
      projectId: projectRoot,
      liveConfig,
    });

    expect(calls.some((c) => c.kind === 'canopy.scan')).toBe(false);
  });
});

describe('CanopyDeltaScanRunner', () => {
  it('debounces back-to-back triggers within the window', async () => {
    write('a.ts', 'export const a = 1;\n');
    const { logger, calls } = buildLogger();
    const runner = new CanopyDeltaScanRunner({
      db: getDatabase(),
      logger,
      machineId: 'local',
      projectRoot,
      projectId: projectRoot,
      liveConfig,
    });
    await runner.run(1_000);
    await runner.run(1_000 + CANOPY_DELTA_DEBOUNCE_MS - 1);
    const runs = calls.filter((c) => c.kind === 'canopy.scan').length;
    expect(runs).toBe(1);
  });

  it('runs again after the debounce window elapses', async () => {
    write('a.ts', 'export const a = 1;\n');
    const { logger, calls } = buildLogger();
    const runner = new CanopyDeltaScanRunner({
      db: getDatabase(),
      logger,
      machineId: 'local',
      projectRoot,
      projectId: projectRoot,
      liveConfig,
    });
    await runner.run(1_000);
    await runner.run(1_000 + CANOPY_DELTA_DEBOUNCE_MS + 1);
    const runs = calls.filter((c) => c.kind === 'canopy.scan').length;
    expect(runs).toBe(2);
  });
});

describe('CanopyBackgroundScan', () => {
  it('respects the configured period', async () => {
    let runs = 0;
    const fakeDelta = { run: async () => { runs++; } };
    const cfg = { current: MycoConfigSchema.parse({
      version: 3,
      canopy: { refresh: { background_period_minutes: 1 } },
    }) };
    const { logger } = buildLogger();
    const bg = new CanopyBackgroundScan({ liveConfig: cfg, delta: fakeDelta as unknown as CanopyDeltaScanRunner, logger });
    await bg.tick();
    await bg.tick(); // immediately — should be skipped by the period gate
    expect(runs).toBe(1);
  });

  it('skips entirely when background_enabled is false', async () => {
    let runs = 0;
    const fakeDelta = { run: async () => { runs++; } };
    const cfg = { current: MycoConfigSchema.parse({
      version: 3,
      canopy: { refresh: { background_enabled: false } },
    }) };
    const { logger } = buildLogger();
    const bg = new CanopyBackgroundScan({ liveConfig: cfg, delta: fakeDelta as unknown as CanopyDeltaScanRunner, logger });
    await bg.tick();
    expect(runs).toBe(0);
  });
});

describe('mass-add kick (Change 3 trigger)', () => {
  it('runCanopyScan calls onCanopyMassAdd when added > threshold', async () => {
    // Threshold is 10. Write 12 files so the populate adds 12 > 10.
    for (let i = 0; i < 12; i++) write(`f${i}.ts`, `export const x${i} = ${i};\n`);
    const { logger } = buildLogger();
    let kicks = 0;
    await runCanopyScan({
      db: getDatabase(),
      logger,
      machineId: 'local',
      projectRoot,
      projectId: projectRoot,
      liveConfig,
      onCanopyMassAdd: () => { kicks++; },
    });
    expect(kicks).toBe(1);
  });

  it('runCanopyScan does NOT call onCanopyMassAdd when added is small (steady churn)', async () => {
    // Write 3 files — comfortably under the threshold of 10. A normal
    // working session adds 1–5 rows; the kick must not fire.
    for (let i = 0; i < 3; i++) write(`f${i}.ts`, `export const x${i} = ${i};\n`);
    const { logger } = buildLogger();
    let kicks = 0;
    await runCanopyScan({
      db: getDatabase(),
      logger,
      machineId: 'local',
      projectRoot,
      projectId: projectRoot,
      liveConfig,
      onCanopyMassAdd: () => { kicks++; },
    });
    expect(kicks).toBe(0);
  });

  it('runInitialCanopyPopulate kicks via onCanopyMassAdd on a fresh vault', async () => {
    // Initial populate runs runCanopyScan internally — fresh table, all
    // files added, count > threshold. The recovery-from-wipe scenario
    // exercises the same code path.
    for (let i = 0; i < 15; i++) write(`f${i}.ts`, `export const x${i} = ${i};\n`);
    const { logger } = buildLogger();
    let kicks = 0;
    await runInitialCanopyPopulate({
      db: getDatabase(),
      logger,
      machineId: 'local',
      projectRoot,
      projectId: projectRoot,
      liveConfig,
      onCanopyMassAdd: () => { kicks++; },
    });
    expect(kicks).toBe(1);
  });

  it('CanopyDeltaScanRunner kicks via onCanopyMassAdd when delta scan adds many rows', async () => {
    // Set up: write 12 files, run a delta scan against an empty table
    // (so all 12 register as "added"), confirm the kick fires.
    for (let i = 0; i < 12; i++) write(`f${i}.ts`, `export const x${i} = ${i};\n`);
    const { logger } = buildLogger();
    let kicks = 0;
    const runner = new CanopyDeltaScanRunner({
      db: getDatabase(),
      logger,
      machineId: 'local',
      projectRoot,
      projectId: projectRoot,
      liveConfig,
      onCanopyMassAdd: () => { kicks++; },
    });
    await runner.run();
    // Drain the microtask queue used by setTimeout(0) inside execute().
    await new Promise((r) => setTimeout(r, 5));
    expect(kicks).toBe(1);
  });
});

