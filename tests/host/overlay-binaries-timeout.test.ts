/**
 * The command runner must ALWAYS SETTLE, without bounding slow provisioning.
 *
 * Two failures this guards, which pull in opposite directions:
 *  · No timeout at all → a wedged child leaves the promise pending forever, and
 *    the overlay retire sits on the daemon's BOOT path, so boot hangs.
 *  · A short blanket timeout → `brew install --formula tailscale` and the
 *    tarball extraction run through this same runner and legitimately take
 *    minutes, so `host enable` fails on exactly the fresh box it sets up.
 * The resolution is a generous default plus a short per-call override.
 */
import { describe, expect, it } from 'bun:test';

import {
  COMMAND_RUNNER_TIMEOUT_MS,
  OVERLAY_COMMAND_TIMEOUT_MS,
  realCommandRunner,
} from '@myco/host/overlay-binaries.js';

describe('realCommandRunner settles', () => {
  it('a hung child resolves as a failure rather than pending forever', async () => {
    const started = Date.now();
    const res = await realCommandRunner.run('sleep', ['30'], { timeoutMs: 300 });

    expect(res.exitCode).toBe(124);
    expect(res.stdout).toMatch(/timed out after 300ms/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('a normal command is unaffected by the timeout', async () => {
    const res = await realCommandRunner.run('echo', ['ok'], { timeoutMs: 5000 });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('ok');
  });
});

describe('timeout budgets', () => {
  it('the default is generous enough for a cold `brew install`', () => {
    // A short default here is the regression: it would kill provisioning on a
    // fresh macOS box, which is the one machine `host enable` exists to set up.
    expect(COMMAND_RUNNER_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it('the overlay-forward budget is short, because it is on the boot path', () => {
    expect(OVERLAY_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(OVERLAY_COMMAND_TIMEOUT_MS).toBeLessThan(COMMAND_RUNNER_TIMEOUT_MS);
  });
});
