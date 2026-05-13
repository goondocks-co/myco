import { describe, it, expect } from 'bun:test';
import { EventLoopLagProbe } from '@myco/daemon/event-loop-lag.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

interface LogCall {
  level: 'warn' | 'debug' | 'info' | 'error';
  kind: string;
  message: string;
  data?: Record<string, unknown>;
}

function captureLogger(): { logs: LogCall[]; logger: any } {
  const logs: LogCall[] = [];
  const push = (level: LogCall['level']) =>
    (kind: string, message: string, data?: Record<string, unknown>) => {
      logs.push({ level, kind, message, data });
    };
  return {
    logs,
    logger: {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    },
  };
}

function blockSync(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // busy-wait — synchronously holds the event loop the way a sync
    // bun:sqlite query or a JSON.parse on a large buffer would.
  }
}

const FAST_INTERVAL = 25;
const ABOVE_INTERVAL = FAST_INTERVAL + 10;

describe('EventLoopLagProbe', () => {
  it('does not emit when the loop is responsive', async () => {
    const { logs, logger } = captureLogger();
    const probe = new EventLoopLagProbe(logger, {
      sampleIntervalMs: FAST_INTERVAL,
      warnThresholdMs: 200,
    });
    probe.start();
    await new Promise((r) => setTimeout(r, FAST_INTERVAL * 5));
    probe.stop();

    const lagWarns = logs.filter((entry) => entry.kind === LOG_KINDS.DAEMON_LAG);
    expect(lagWarns.length).toBe(0);
  });

  it('emits a warning when the loop is blocked past the threshold', async () => {
    const { logs, logger } = captureLogger();
    const probe = new EventLoopLagProbe(logger, {
      sampleIntervalMs: FAST_INTERVAL,
      warnThresholdMs: 100,
    });
    probe.start();

    // Let the probe take one clean sample, then pin the loop for ~300ms.
    await new Promise((r) => setTimeout(r, ABOVE_INTERVAL));
    blockSync(300);
    await new Promise((r) => setTimeout(r, FAST_INTERVAL * 3));
    probe.stop();

    const lagWarns = logs.filter((entry) => entry.kind === LOG_KINDS.DAEMON_LAG);
    expect(lagWarns.length).toBeGreaterThanOrEqual(1);
    const observedLag = lagWarns[0].data?.lagMs as number;
    expect(observedLag).toBeGreaterThanOrEqual(100);
    expect(probe.getStats().peakLagMs).toBeGreaterThanOrEqual(observedLag);
    expect(probe.getStats().stallCount).toBeGreaterThanOrEqual(1);
  });

  it('stop() halts further samples', async () => {
    const { logs, logger } = captureLogger();
    const probe = new EventLoopLagProbe(logger, {
      sampleIntervalMs: FAST_INTERVAL,
      warnThresholdMs: 50,
    });
    probe.start();
    await new Promise((r) => setTimeout(r, ABOVE_INTERVAL));
    probe.stop();
    const lagWarnsAtStop = logs.filter((entry) => entry.kind === LOG_KINDS.DAEMON_LAG).length;

    // Block well past the threshold; if stop() worked, no further warns fire.
    blockSync(200);
    await new Promise((r) => setTimeout(r, FAST_INTERVAL * 3));

    const lagWarnsAfter = logs.filter((entry) => entry.kind === LOG_KINDS.DAEMON_LAG).length;
    expect(lagWarnsAfter).toBe(lagWarnsAtStop);
  });
});
