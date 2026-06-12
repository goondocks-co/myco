/**
 * RC-8 — last-resort process guards + survival of the daemon's background
 * loops under failure. Bun exits code 1 on any unhandled rejection; these
 * tests pin the contract that a background failure logs and the process
 * (and its loops) continue.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { installProcessGuards, type ProcessGuardsHandle } from '@myco/daemon/process-guards';
import { PowerManager } from '@myco/daemon/power.js';
import { JobRunner } from '@myco/daemon/job-runner.js';

const ORPHAN_HELPER = path.join(import.meta.dir, '..', 'helpers', 'process-guards-orphan-helper.ts');

function collectingLogger() {
  const entries: Array<{ level: string; kind: string; message: string; data?: Record<string, unknown> }> = [];
  return {
    entries,
    debug: (kind: string, message: string, data?: Record<string, unknown>) => entries.push({ level: 'debug', kind, message, data }),
    info: (kind: string, message: string, data?: Record<string, unknown>) => entries.push({ level: 'info', kind, message, data }),
    warn: (kind: string, message: string, data?: Record<string, unknown>) => entries.push({ level: 'warn', kind, message, data }),
    error: (kind: string, message: string, data?: Record<string, unknown>) => entries.push({ level: 'error', kind, message, data }),
  };
}

describe('RC-8 — process guards', () => {
  let handle: ProcessGuardsHandle | null = null;

  afterEach(() => {
    handle?.uninstall();
    handle = null;
  });

  it('unhandledRejection logs through the bound logger and does not exit', async () => {
    const logger = collectingLogger();
    const exits: number[] = [];
    handle = installProcessGuards({ exit: (code) => exits.push(code) });
    handle.bindLogger(logger);

    // bun:test tracks real unhandled rejections itself and fails the test
    // before process listeners settle — emit directly; the child-process
    // integration test below covers the real event path end-to-end.
    process.emit('unhandledRejection', new Error('rc8-synthetic-rejection'), Promise.resolve());

    expect(exits).toEqual([]);
    const hit = logger.entries.find((e) => e.kind === 'daemon.unhandled_rejection');
    expect(hit).toBeDefined();
    expect(String(hit?.data?.reason)).toContain('rc8-synthetic-rejection');
    expect(hit?.data?.stack).toBeTruthy();
  });

  it('falls back to stderr before the logger is bound', async () => {
    const stderrLines: string[] = [];
    handle = installProcessGuards({
      exit: () => {},
      stderr: (line) => stderrLines.push(line),
    });

    process.emit('unhandledRejection', new Error('pre-logger-rejection'), Promise.resolve());

    expect(stderrLines.some((l) => l.includes('pre-logger-rejection'))).toBe(true);
  });

  it('uncaughtException logs then exits 1 via the injected exit', () => {
    const logger = collectingLogger();
    const exits: number[] = [];
    handle = installProcessGuards({ exit: (code) => exits.push(code), stderr: () => {} });
    handle.bindLogger(logger);

    // Invoke the exception path directly through process.emit — throwing for
    // real would tear down the test runner.
    process.emit('uncaughtException', new Error('rc8-synthetic-exception'));

    expect(exits).toEqual([1]);
    const hit = logger.entries.find((e) => e.kind === 'daemon.uncaught_exception');
    expect(hit).toBeDefined();
  });

  it('a throwing logger substitute cannot break the guard', async () => {
    const stderrLines: string[] = [];
    handle = installProcessGuards({ exit: () => {}, stderr: (line) => stderrLines.push(line) });
    handle.bindLogger({
      debug: () => { throw new Error('bad logger'); },
      info: () => { throw new Error('bad logger'); },
      warn: () => { throw new Error('bad logger'); },
      error: () => { throw new Error('bad logger'); },
    });

    process.emit('unhandledRejection', new Error('guard-resilience'), Promise.resolve());

    expect(stderrLines.some((l) => l.includes('guard-resilience'))).toBe(true);
  });

  it('integration: a bun child with guards installed survives an unhandled rejection (exit 0)', async () => {
    const child = spawn(process.execPath, [ORPHAN_HELPER], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    // 'close' (stdio flushed), not 'exit' — asserting on stdout after a bare
    // 'exit' is the local-green/CI-red flake shape. Kill on timeout so a
    // wedged child never outlives the test file.
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('child never exited'));
      }, 10_000);
      child.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });
    expect(stdout).toContain('ALIVE');
    expect(exitCode).toBe(0);
  });
});

describe('RC-8 — power tick survives failures', () => {
  it('a throwing onTick logs and the loop schedules the next tick', async () => {
    const logger = collectingLogger();
    let ticks = 0;
    const pm = new PowerManager({
      idleThresholdMs: 5_000,
      sleepThresholdMs: 30_000,
      deepSleepThresholdMs: 90_000,
      activeIntervalMs: 10,
      sleepIntervalMs: 10,
      logger: logger as never,
      onTick: () => { ticks++; throw new Error('tick bomb'); },
      deepSleepHolder: () => null,
    });
    pm.start();
    // Real timers: wait long enough for several ticks; a dead loop stops at 1.
    await new Promise((r) => setTimeout(r, 120));
    pm.stop();

    expect(ticks).toBeGreaterThan(1);
    expect(logger.entries.some((e) => e.message.includes('Power tick failed'))).toBe(true);
  });

  it('a throwing onTick AND throwing logger still cannot kill the loop', async () => {
    // Armed after start(): start() itself logs, which is not the surface
    // under test — the tick path's catch falls back to logger.error, and
    // even THAT throwing must not stop the loop.
    let armed = false;
    const bomb = () => { if (armed) throw new Error('logger bomb'); };
    const throwing = { debug: bomb, info: bomb, warn: bomb, error: bomb };
    let ticks = 0;
    const pm = new PowerManager({
      idleThresholdMs: 5_000,
      sleepThresholdMs: 30_000,
      deepSleepThresholdMs: 90_000,
      activeIntervalMs: 10,
      sleepIntervalMs: 10,
      logger: throwing as never,
      onTick: () => { ticks++; throw new Error('tick bomb'); },
      deepSleepHolder: () => null,
    });
    pm.start();
    armed = true;
    await new Promise((r) => setTimeout(r, 80));
    armed = false;
    pm.stop();
    expect(ticks).toBeGreaterThan(1);
  });
});

describe('RC-8 — JobRunner settle never strands a job', () => {
  it('a throwing logger in settle still clears inFlight (job dispatchable again)', async () => {
    let logCalls = 0;
    const throwingLogger = {
      debug: () => {},
      info: () => { logCalls++; throw new Error('settle logger bomb'); },
      warn: () => {},
      error: () => {},
    };
    let runs = 0;
    const r = new JobRunner({ concurrency: 2, logger: throwingLogger as never, clock: () => 0 });
    r.register({
      name: 'rc8-job',
      runIn: ['active'],
      kind: 'housekeeping',
      fn: async () => { runs++; },
    });

    r.dispatch('active');
    await new Promise((res) => setTimeout(res, 20));
    expect(runs).toBe(1);
    expect(logCalls).toBeGreaterThan(0);

    // If settle's logger throw had stranded the job in inFlight, the
    // single-flight filter would skip this dispatch forever.
    r.dispatch('active');
    await new Promise((res) => setTimeout(res, 20));
    expect(runs).toBe(2);
  });

  it('a rejecting job fn settles with backoff and produces no unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      const errors: string[] = [];
      const r = new JobRunner({
        concurrency: 2,
        logger: collectingLogger() as never,
        clock: () => 0,
        onError: (name) => errors.push(name),
      });
      r.register({
        name: 'rc8-failing-job',
        runIn: ['active'],
        kind: 'housekeeping',
        fn: async () => { throw new Error('job bomb'); },
      });
      r.dispatch('active');
      await new Promise((res) => setTimeout(res, 20));
      expect(errors).toEqual(['rc8-failing-job']);
      expect(rejections).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
  });
});
