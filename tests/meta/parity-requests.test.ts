import { expect, test } from 'bun:test';
import { PARITY_REQUEST_HEADER, PARITY_WORKER_HEADER, withParityRequests, type RequestFailure } from '../parity/requests.ts';
import type { ParityTarget } from '../parity/harness.ts';
import { observedWorker } from '../parity/observed-worker.ts';

test('records a 5xx body and Worker identity without consuming or retrying the response', async () => {
  const failures: RequestFailure[] = [];
  let calls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    calls++;
    return new Response('D1 exploded', { status: 503, headers: { [PARITY_WORKER_HEADER]: request.headers.get(PARITY_REQUEST_HEADER)! } });
  } });
  const target = { url: server.url.origin, requestFailure: async (failure: RequestFailure) => { failures.push(failure); } } as ParityTarget;
  const original = fetch;
  try {
    await withParityRequests([target], async () => {
      const response = await fetch(server.url + 'api/settings', { method: 'PUT', body: '{}' });
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('D1 exploded');
    });
    expect(fetch).toBe(original);
    expect(calls).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ method: 'PUT', path: '/api/settings', status: 503, body: 'D1 exploded' });
    expect(failures[0]!.worker).toBe(failures[0]!.id);
  } finally { server.stop(true); }
});

test('a dropped connection and an assertion each propagate once and restore fetch', async () => {
  const failures: RequestFailure[] = [];
  const target = { url: 'http://127.0.0.1:1', requestFailure: async (failure: RequestFailure) => { failures.push(failure); } } as ParityTarget;
  const original = fetch;
  await expect(withParityRequests([target], async () => { await fetch(target.url); })).rejects.toThrow();
  expect(fetch).toBe(original);
  expect(failures).toHaveLength(1);
  expect(failures[0]!.error).toBeString();
  let attempts = 0;
  await expect(withParityRequests([target], async () => { attempts++; throw new Error('assertion'); })).rejects.toThrow('assertion');
  expect(attempts).toBe(1);
  expect(fetch).toBe(original);
});

test('only Worker responses carry the trace, including a handler 500', async () => {
  const worker = observedWorker({ fetch: async () => new Response('handler error', { status: 500 }) });
  const request = new Request('http://local/api/settings', { headers: { [PARITY_REQUEST_HEADER]: 'trace' } });
  const response = await worker.fetch(request, {} as Parameters<typeof worker.fetch>[1]);
  expect(response.status).toBe(500);
  expect(response.headers.get(PARITY_WORKER_HEADER)).toBe('trace');
  expect(await response.text()).toBe('handler error');
});
