/**
 * Regression test: a stuck/slow streaming upstream consumed by the
 * instrumented fetch wrapper does not pin the event loop. `/health`
 * remains responsive throughout — the property a worker_threads
 * isolation would also guarantee, but here enforced via the wrapper's
 * per-chunk `setImmediate` yields plus the no-progress watchdog.
 *
 * Reproduces (in miniature) the failure mode that motivated the work:
 * canopy-describe drove gpt-oss-20b via LMStudio, the response stream
 * misbehaved, and the daemon's HTTP listener stopped accepting
 * connections for >60s. With the wrapper + yields in place, /health
 * answers in milliseconds even while many chunks are flowing.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import http from 'node:http';
import { vi } from '../helpers/vi-shim.js';
import { createInstrumentedFetch } from '@myco/utils/instrumented-fetch.js';
import { EventLoopLagProbe } from '@myco/daemon/event-loop-lag.js';

interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

async function startHealthServer(): Promise<RunningServer> {
  // Mirror the daemon's raw-route fast path: a tiny GET /health handler
  // that does no DB work, no AsyncLocalStorage, just answers JSON.
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function timedHealthCheck(port: number): Promise<number> {
  const start = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  await res.text();
  return Date.now() - start;
}

function buildSlowChunkStream(opts: {
  chunkCount: number;
  chunkSizeBytes: number;
  intraChunkDelayMs: number;
}): ReadableStream<Uint8Array> {
  const payload = new Uint8Array(opts.chunkSizeBytes).fill(0x78); // 'x'
  return new ReadableStream({
    async start(controller) {
      for (let i = 0; i < opts.chunkCount; i += 1) {
        controller.enqueue(payload);
        if (opts.intraChunkDelayMs > 0) {
          await new Promise((r) => setTimeout(r, opts.intraChunkDelayMs));
        }
      }
      controller.close();
    },
  });
}

describe('agent loop responsiveness regression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps /health latency low while a slow stream is being consumed', async () => {
    const server = await startHealthServer();
    // Capture the original loopback-capable fetch BEFORE stubbing the
    // global one, so /health probes don't get routed through the
    // upstream-simulating stub below.
    const realFetch = globalThis.fetch.bind(globalThis);
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === 'string' ? url : url.toString();
          if (urlStr.includes('/api/echo')) {
            return new Response(
              buildSlowChunkStream({ chunkCount: 60, chunkSizeBytes: 4096, intraChunkDelayMs: 8 }),
              { status: 200 },
            );
          }
          return realFetch(url, init);
        }),
      );

      const instrumented = createInstrumentedFetch({
        component: 'test.regression',
        responseHeadersTimeoutMs: 5_000,
        idleTimeoutMs: 5_000,
      });

      let consumeDone = false;
      const consumeStream = (async () => {
        const response = await instrumented('http://upstream.test/api/echo');
        await response.text();
      })().finally(() => {
        consumeDone = true;
      });

      const latencies: number[] = [];
      const probeTask = (async () => {
        while (!consumeDone) {
          try {
            const url = `http://127.0.0.1:${server.port}/health`;
            const start = Date.now();
            const res = await realFetch(url);
            await res.text();
            latencies.push(Date.now() - start);
          } catch {
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      })();

      await consumeStream;
      await probeTask;

      expect(latencies.length).toBeGreaterThan(5);
      const max = Math.max(...latencies);
      expect(max).toBeLessThan(200);
    } finally {
      await server.close();
    }
  });

  it('lag probe records a stall when consumption is artificially synchronous', async () => {
    const logs: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const logger: any = {
      debug: () => {},
      info: () => {},
      warn: (kind: string, _msg: string, data?: Record<string, unknown>) => {
        logs.push({ kind, data });
      },
      error: () => {},
    };
    const probe = new EventLoopLagProbe(logger, {
      sampleIntervalMs: 30,
      warnThresholdMs: 120,
    });
    probe.start();
    await new Promise((r) => setTimeout(r, 60));
    // Synchronous busy-wait — what a stalled sync bun:sqlite call would
    // do to the loop. The probe must see and report this.
    const deadline = Date.now() + 250;
    while (Date.now() < deadline) { /* spin */ }
    await new Promise((r) => setTimeout(r, 100));
    probe.stop();

    const stalls = logs.filter((l) => l.kind === 'daemon.lag');
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    expect(probe.getStats().peakLagMs).toBeGreaterThanOrEqual(120);
  });
});
