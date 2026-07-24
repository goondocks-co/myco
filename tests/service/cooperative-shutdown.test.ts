import { describe, expect, test } from 'bun:test';
import {
  requestCooperativeShutdown,
  requestCooperativeShutdownResult,
} from '../../packages/myco/src/service/cooperative-shutdown';

const noSleep = async () => {};

describe('requestCooperativeShutdown', () => {
  test('returns true when /api/shutdown acks 202 and /health then stops answering', async () => {
    let shutdownPosted = false;
    let healthCalls = 0;
    const fetchFn = (async (url: string, opts?: { method?: string }) => {
      if (String(url).endsWith('/api/shutdown')) {
        shutdownPosted = opts?.method === 'POST';
        return { status: 202, ok: true } as Response;
      }
      healthCalls += 1;
      if (healthCalls >= 2) throw new Error('ECONNREFUSED'); // daemon has exited
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const result = await requestCooperativeShutdown(28876, { fetchFn, sleep: noSleep, pollMs: 1, graceMs: 1000 });
    expect(shutdownPosted).toBe(true);
    expect(result).toBe(true);
  });

  test('returns false when /api/shutdown is not 202 (foreign service or pre-route daemon)', async () => {
    const fetchFn = (async () => ({ status: 200, ok: true }) as Response) as unknown as typeof fetch;
    expect(await requestCooperativeShutdown(28876, { fetchFn, sleep: noSleep })).toBe(false);
  });

  test('returns false when the daemon accepts but never exits within the grace budget', async () => {
    const fetchFn = (async (url: string) =>
      (String(url).endsWith('/api/shutdown')
        ? { status: 202, ok: true }
        : { ok: true, status: 200 }) as Response) as unknown as typeof fetch;
    // graceMs tiny + no-op sleep → the health poll never sees the daemon leave.
    expect(await requestCooperativeShutdown(28876, { fetchFn, sleep: noSleep, pollMs: 1, graceMs: 3 })).toBe(false);
  });

  test('returns false when the POST itself throws', async () => {
    const fetchFn = (async () => { throw new Error('connection refused'); }) as unknown as typeof fetch;
    expect(await requestCooperativeShutdown(28876, { fetchFn })).toBe(false);
  });

  test('distinguishes an explicit shutdown refusal from an unavailable daemon', async () => {
    const fetchFn = (async () => ({ status: 409, ok: false }) as Response) as unknown as typeof fetch;

    expect(await requestCooperativeShutdownResult(28876, { fetchFn, sleep: noSleep }))
      .toEqual({ kind: 'refused', status: 409 });
  });
});
