import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { MycoConfigSchema } from '@myco/config/schema';
import { runCanopyScan } from '@myco/daemon/jobs/canopy-scan';
import {
  CanopyDeltaScanRunner,
  CANOPY_DELTA_DEBOUNCE_MS,
} from '@myco/daemon/jobs/canopy-delta-scan';
import {
  CanopyBackgroundScan,
  parseDuration,
} from '@myco/daemon/jobs/canopy-background-scan';

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
      canopy: { refresh: { background_period: '60s' } },
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

describe('parseDuration', () => {
  it('parses the standard humanised forms', () => {
    expect(parseDuration('30s')).toBe(30);
    expect(parseDuration('5m')).toBe(300);
    expect(parseDuration('1h')).toBe(3600);
    expect(parseDuration('1d')).toBe(86_400);
  });

  it('treats a bare number as seconds', () => {
    expect(parseDuration('45')).toBe(45);
  });

  it('returns 0 for unparseable input', () => {
    expect(parseDuration('forever')).toBe(0);
    expect(parseDuration('')).toBe(0);
  });
});
