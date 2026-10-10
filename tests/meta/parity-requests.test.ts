import { expect, spyOn, test } from 'bun:test';
import net from 'node:net';
import { connectRequest, PARITY_REQUEST_HEADER, PARITY_WORKER_HEADER, withParityRequests, type RequestFailure } from '../parity/requests.ts';
import type { ParityTarget } from '../parity/harness.ts';
import { observedWorker, observeHandledException } from '../parity/observed-worker.ts';

async function listen(server: net.Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the socket fixture requires a TCP address');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('real socket: a POST reset after its bytes arrive is never replayed by the wrapper', async () => {
  let accepted = 0, received = '', calls = 0;
  const body = '{"write":1}';
  const server = net.createServer(socket => {
    accepted++;
    socket.on('data', data => {
      received += data.toString();
      if (received.includes(body)) socket.destroy();
    });
  });
  const url = await listen(server);
  const failures: RequestFailure[] = [];
  const target = { url, requestFailure: async (failure: RequestFailure) => { failures.push(failure); } } as ParityTarget;
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls++;
    return original(input, init);
  }, { preconnect: original.preconnect });
  try {
    await expect(withParityRequests([target], async () => { await fetch(url + '/write', { method: 'POST', body }); })).rejects.toThrow();
    expect(accepted).toBe(1);
    expect(calls).toBe(1);
    expect(received).toContain(body);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error).toBeString();
  } finally {
    globalThis.fetch = original;
    await close(server);
  }
});

test('real socket: a refused connection gets exactly two attempts through the wrapper', async () => {
  const server = net.createServer();
  const url = await listen(server);
  await close(server);
  const failures: RequestFailure[] = [];
  const target = { url, requestFailure: async (failure: RequestFailure) => { failures.push(failure); } } as ParityTarget;
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls++;
    return original(input, init);
  }, { preconnect: original.preconnect });
  try {
    await expect(withParityRequests([target], async () => { await fetch(url + '/write', { method: 'POST', body: 'a' }); })).rejects.toThrow();
    expect(calls).toBe(2);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error).toBeString();
  } finally { globalThis.fetch = original; }
});

test('large 5xx diagnostics retain UTF-8 head and tail within 8 KiB and preserve the full response', async () => {
  const body = 'HEAD ' + '🍄'.repeat(5000) + ' TAIL';
  const failures: RequestFailure[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(body, { status: 500 }) });
  const target = { url: server.url.origin, requestFailure: async (failure: RequestFailure) => { failures.push(failure); } } as ParityTarget;
  try {
    await withParityRequests([target], async () => {
      const response = await fetch(server.url);
      expect(await response.text()).toBe(body);
    });
    expect(failures).toHaveLength(1);
    const excerpt = failures[0]!.body!;
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(8 * 1024);
    expect(excerpt.startsWith('HEAD ')).toBe(true);
    expect(excerpt.endsWith(' TAIL')).toBe(true);
    expect(excerpt).toContain('... response body truncated ...');
    expect(excerpt).not.toContain('�');
  } finally { server.stop(true); }
});

test('records a 5xx body and Worker identity without consuming or retrying the response', async () => {
  const failures: RequestFailure[] = [];
  let calls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    calls++;
    expect(request.headers.get('connection')).toBe('close');
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

test('retries only a refused TCP connect once; resets, responses and assertions are never replayed', async () => {
  let calls = 0;
  const refused = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
  expect(await connectRequest(async () => { if (++calls === 1) throw refused; return 'connected'; })).toBe('connected');
  expect(calls).toBe(2);
  calls = 0;
  await expect(connectRequest(async () => { calls++; throw refused; })).rejects.toBe(refused);
  expect(calls).toBe(2);
  for (const error of [Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }), new Error('assertion')]) {
    calls = 0;
    await expect(connectRequest(async () => { calls++; throw error; })).rejects.toBe(error);
    expect(calls).toBe(1);
  }
  calls = 0;
  expect((await connectRequest(async () => { calls++; return new Response('handler failed', { status: 500 }); })).status).toBe(500);
  expect(calls).toBe(1);
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

test('handled Worker exceptions retain their stack and the matching request identity', async () => {
  const logs = spyOn(console, 'error').mockImplementation(() => {});
  const error = new Error('D1 refusal probe');
  try {
    const worker = observedWorker({ fetch: async () => {
      await Promise.resolve();
      observeHandledException(error);
      return new Response('unavailable', { status: 503 });
    } });
    await worker.fetch(new Request('http://local/api/settings', { headers: { [PARITY_REQUEST_HEADER]: 'handled-trace' } }), {} as Parameters<typeof worker.fetch>[1]);
    expect(JSON.parse(logs.mock.calls[0]![0] as string)).toMatchObject({
      kind: 'parity_handled_exception', id: 'handled-trace', path: '/api/settings', error: error.stack,
    });
  } finally { logs.mockRestore(); }
});

test('diagnostic recording failure retains the dropped request as its cause', async () => {
  const target = { url: 'http://127.0.0.1:1', requestFailure: async (_failure: RequestFailure): Promise<void> => { throw new Error('diagnostic disk full'); } } as ParityTarget;
  try {
    await withParityRequests([target], async () => { await fetch(target.url); });
    throw new Error('request unexpectedly succeeded');
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    const failure = error as AggregateError;
    expect(failure.cause).toBe(failure.errors[0]);
    expect(failure.errors[1].message).toBe('diagnostic disk full');
  }
});
