import { describe, expect, it } from 'bun:test';
import { cloudflareBlobReader, cloudflareObjectStore, type CloudflareFetch } from '@myco/server/cloudflare.js';
import { refusedAccountCode, transientReadFailure } from '@myco/server/object-read.js';
import { CommandFailed, CommandTimedOut, type CommandRunner } from '@myco/server/runner.js';
import { brotliCompressSync, gzipSync, zstdCompressSync } from 'node:zlib';

const options = { accountId: 'fixture-account', bucketName: 'fixture-bucket', configDir: '/operator' };

it('shares one operator login across object streams, pins the API origin and disables credential logging', async () => {
  let authentications = 0;
  const runner: CommandRunner = { async run(command, args, runOptions) {
    authentications += 1;
    expect(command).toBe('npx');
    expect(args).toEqual(['--no-install', 'wrangler', 'auth', 'token', '--json']);
    expect(runOptions?.cwd).toBe('/operator');
    expect(runOptions?.env).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: options.accountId, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG: 'log', WRANGLER_LOG_SANITIZE: 'true' });
    return { code: 0, stdout: JSON.stringify({ type: 'oauth', token: 'fixture-token' }), stderr: '' };
  } };
  const urls: string[] = [];
  const read = cloudflareBlobReader({ ...options, runner, fetch: async (input, init) => {
    urls.push(String(input));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-token');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // R2 honours this and sends the stored bytes, so no decode stands between the connection and the digest check.
    expect(new Headers(init?.headers).get('accept-encoding')).toBe('identity');
    return new Response(new Uint8Array([0, 127, 255]));
  } });
  const bodies = await Promise.all(['project/a', 'project/b', 'project/key?#'].map(async (key) => new Uint8Array(await new Response(await read(key)).arrayBuffer())));
  expect(authentications).toBe(1);
  expect(bodies).toEqual(Array.from({ length: 3 }, () => new Uint8Array([0, 127, 255])));
  expect(urls.at(-1)).toBe('https://api.cloudflare.com/client/v4/accounts/fixture-account/r2/buckets/fixture-bucket/objects/project/key%3F%23');
});

it('refreshes a rejected login once and keeps an authentication failure explicit without echoing secrets', async () => {
  let authentications = 0;
  let requests = 0;
  const read = cloudflareBlobReader({ ...options, runner: { async run() {
    authentications += 1;
    return { code: 0, stdout: JSON.stringify({ type: 'api_token', token: `fixture-private-${authentications}` }), stderr: '' };
  } }, fetch: async () => {
    requests += 1;
    return new Response('fixture-private-response', { status: 403 });
  } });
  let message = '';
  try { await read('project/key'); } catch (error) { message = String(error); }
  expect(message).toContain('HTTP 403');
  expect(message).not.toContain('fixture-private');
  expect({ authentications, requests }).toEqual({ authentications: 2, requests: 2 });
});

it('uses a refreshed OAuth token for the resumed object request', async () => {
  let authentications = 0;
  const read = cloudflareBlobReader({ ...options, runner: { async run() {
    return { code: 0, stdout: JSON.stringify({ type: 'oauth', token: `fixture-${++authentications}` }), stderr: '' };
  } }, fetch: async (_input, init) => new Headers(init?.headers).get('authorization') === 'Bearer fixture-1'
    ? new Response(null, { status: 401 }) : new Response('recovered') });
  expect(await new Response(await read('project/key')).text()).toBe('recovered');
  expect(authentications).toBe(2);
});

it('supports the operator API-key login without turning it into a bearer token', async () => {
  const read = cloudflareBlobReader({ ...options, runner: { async run() {
    return { code: 0, stdout: JSON.stringify({ type: 'api_key', key: 'fixture-key', email: 'fixture@example.invalid' }), stderr: '' };
  } }, fetch: async (_input, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-auth-key')).toBe('fixture-key');
    expect(headers.get('x-auth-email')).toBe('fixture@example.invalid');
    return new Response('body');
  } });
  expect(await new Response(await read('project/key')).text()).toBe('body');
});

it('refuses malformed or failed credential responses before any object request without exposing their output', async () => {
  for (const result of [
    { code: 1, stdout: 'fixture-private-stdout', stderr: 'fixture-private-stderr' },
    { code: 0, stdout: JSON.stringify({ type: 'api_token', token: 'fixture-private\r\nvalue' }), stderr: '' },
  ]) {
    const read = cloudflareBlobReader({ ...options, runner: { run: async () => result }, fetch: async () => { throw new Error('unexpected fetch'); } });
    let message = '';
    try { await read('project/key'); } catch (error) { message = String(error); }
    expect(message).toContain('Wrangler');
    expect(message).not.toContain('fixture-private');
    expect(message).not.toContain('unexpected fetch');
  }
});

it('refuses path traversal before obtaining any credential', async () => {
  const read = cloudflareBlobReader({ ...options, runner: { async run() { throw new Error('unexpected credential read'); } } });
  await expect(read('../other-account')).rejects.toThrow('invalid segment');
  await expect(read('project/../key')).rejects.toThrow('invalid segment');
});

it('reopens the upload body after authentication refresh and shares the login with readback', async () => {
  let logins = 0;
  let opened = 0;
  let uploaded = '';
  const store = cloudflareObjectStore({ ...options, runner: { async run() {
    return { code: 0, stdout: JSON.stringify({ type: 'oauth', token: `fixture-${++logins}` }), stderr: '' };
  } }, fetch: async (_url, init) => {
    expect(init.redirect).toBe('error');
    const headers = new Headers(init.headers);
    if (init.method === 'PUT') {
      expect(headers.get('content-length')).toBe('7');
      expect(headers.get('content-type')).toBe('application/octet-stream');
      uploaded = await new Response(init.body).text();
      if (headers.get('authorization') === 'Bearer fixture-1') return new Response(null, { status: 401 });
      return Response.json({ success: true });
    }
    return new Response(uploaded);
  } });
  await store.put('project/key', () => { opened++; return new Blob(['a\0value']); });
  expect(await new Response(await store.get('project/key')).text()).toBe('a\0value');
  expect({ logins, opened }).toEqual({ logins: 2, opened: 2 });
});

it('distinguishes an absent restore object from refusal and rejects unconfirmed writes', async () => {
  let status = 404;
  const store = cloudflareObjectStore({ ...options, runner: { async run() {
    return { code: 0, stdout: JSON.stringify({ type: 'api_token', token: 'fixture-only' }), stderr: '' };
  } }, fetch: async () => status === 200 ? Response.json({ success: false }) : new Response(null, { status }) });
  expect(await store.get('project/key')).toBeNull();
  status = 403;
  await expect(store.get('project/key')).rejects.toThrow('HTTP 403');
  await expect(store.put('project/key', () => new Blob())).rejects.toThrow('HTTP 403');
  status = 200;
  await expect(store.put('project/key', () => new Blob())).rejects.toThrow('did not confirm');
});

it('refuses oversized uploads and malformed acknowledgements without exposing response bodies', async () => {
  let requests = 0;
  const store = cloudflareObjectStore({ ...options, runner: { async run() {
    return { code: 0, stdout: JSON.stringify({ type: 'oauth', token: 'fixture' }), stderr: '' };
  } }, fetch: async () => { requests++; return new Response('synthetic-private-response'); } });
  const oversized = new Blob();
  Object.defineProperty(oversized, 'size', { value: 300_000_001 });
  await expect(store.put('project/key', () => oversized)).rejects.toThrow('300 MB');
  expect(requests).toBe(0);
  await expect(store.put('project/key', () => new Blob())).rejects.toThrow('did not confirm object write');
});

describe('the windows an object read waits in', () => {
  const login: CommandRunner = { async run() { return { code: 0, stdout: JSON.stringify({ type: 'oauth', token: 'fixture' }), stderr: '' }; } };
  const timeouts = { responseMs: 150, stallMs: 150 };
  const reader = (fetch: CloudflareFetch) => cloudflareBlobReader({ ...options, runner: login, fetch, timeouts });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** A request that answers only by honouring its signal, as a connection that never responds does. */
  const unanswered: CloudflareFetch = (_url, init) => new Promise((_, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
  });
  const settled = async (read: Promise<unknown>) => read.then(() => null, (error: unknown) => error);

  /**
   * A body that sends one byte every `gapMs`, as a connection does: it errors with the request's abort reason the
   * moment the request is aborted, so a window that closes over a live transfer ends it here as it would on the wire.
   */
  const trickle = (chunks: number, gapMs: number): { fetch: CloudflareFetch; signal: () => AbortSignal | undefined } => {
    let signal: AbortSignal | undefined;
    return {
      signal: () => signal,
      fetch: async (_url, init) => {
        signal = init.signal ?? undefined;
        return new Response(new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let index = 0; index < chunks; index += 1) {
              await sleep(gapMs);
              if (signal?.aborted) { controller.error(signal.reason); return; }
              controller.enqueue(new Uint8Array([index]));
            }
            controller.close();
          },
        }));
      },
    };
  };

  it('keeps a slow body going for as long as bytes keep arriving', async () => {
    const chunks = 8;
    const source = trickle(chunks, 70);
    const started = Date.now();
    const body = await reader(source.fetch)('project/slow');
    expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(Uint8Array.from({ length: chunks }, (_, index) => index));
    // The whole transfer outlasted both windows several times over, and neither closed over it.
    expect(Date.now() - started).toBeGreaterThan(Math.max(timeouts.responseMs, timeouts.stallMs) * 3);
    expect(source.signal()?.aborted).toBe(false);
  });

  it('leaves no window running once a read has finished', async () => {
    // Windows are told apart from every other timer by their lengths, which nothing else in this read uses.
    const windows = { responseMs: 173, stallMs: 157 };
    const running = new Set<unknown>();
    const { setTimeout: set, clearTimeout: clear } = globalThis;
    globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
      const timer = set(() => { running.delete(timer); handler(); }, ms, ...rest);
      if (ms === windows.responseMs || ms === windows.stallMs) running.add(timer);
      return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => { running.delete(timer); clear(timer); }) as typeof clearTimeout;
    try {
      const source = trickle(4, 20);
      const body = await cloudflareBlobReader({ ...options, runner: login, fetch: source.fetch, timeouts: windows })('project/finished');
      expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3]));
      expect(running.size).toBe(0);
    } finally {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    }
  });

  it('does not count the time its reader spends away from the body', async () => {
    const body = (await reader(async () => new Response(new Uint8Array([1, 2, 3])))('project/idle')).getReader();
    await sleep(timeouts.stallMs * 2);
    expect((await body.read()).value).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('ends a body that stops sending, within one window, as a failure worth retrying', async () => {
    let signal: AbortSignal | undefined;
    const body = await reader(async (_url, init) => {
      signal = init.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); } }));
    })('project/stalled');
    const started = Date.now();
    const failure = await settled(new Response(body).arrayBuffer());
    expect(String(failure)).toContain('stalled: no bytes arrived for 0.15 s');
    expect(transientReadFailure(failure)).toBe(true);
    expect(Date.now() - started).toBeLessThan(timeouts.stallMs * 10);
    // The request itself is ended, so its connection is not held open.
    expect(signal?.aborted).toBe(true);
  }, 5_000);

  it('ends a request whose response never begins, as a failure worth retrying', async () => {
    const started = Date.now();
    const failure = await settled(reader(unanswered)('project/silent'));
    expect(String(failure)).toContain('did not begin answering the read of project/silent');
    expect(transientReadFailure(failure)).toBe(true);
    expect(Date.now() - started).toBeLessThan(timeouts.responseMs * 10);
  }, 5_000);

  it('classifies a server error as worth retrying, and an absent object or refused credential as final', async () => {
    const answering = (status: number) => settled(reader(async () => new Response(null, { status }))('project/key'));
    for (const status of [500, 502, 503, 429]) expect(transientReadFailure(await answering(status))).toBe(true);
    for (const status of [404, 403, 400]) expect(transientReadFailure(await answering(status))).toBe(false);
  });
});

describe('the failures a read may try again', () => {
  const settled = async (read: Promise<unknown>) => read.then(() => null, (error: unknown) => error);

  it('tries again after a refused connection and an unresolvable name, as the runtime reports them', async () => {
    const refused = await settled(fetch('http://127.0.0.1:1/'));
    expect(refused).not.toBeNull();
    expect(transientReadFailure(refused)).toBe(true);
    const unresolved = await settled(fetch('http://myco-recovery-fixture.invalid/'));
    expect(unresolved).not.toBeNull();
    expect(transientReadFailure(unresolved)).toBe(true);
    // The same failure reaches a backup through the object reader unchanged.
    const login: CommandRunner = { async run() { return { code: 0, stdout: JSON.stringify({ type: 'oauth', token: 'fixture' }), stderr: '' }; } };
    const read = cloudflareBlobReader({ ...options, runner: login, fetch: (_url, init) => fetch('http://127.0.0.1:1/', init) });
    expect(transientReadFailure(await settled(read('project/key')))).toBe(true);
  });

  it('tries again after a compressed body cut short, as the runtime reports it for each encoding', async () => {
    const whole = new Uint8Array(64 * 1024).map((_, index) => (index * 7919) % 251);
    for (const [encoding, compressed] of [['gzip', gzipSync(whole)], ['br', brotliCompressSync(whole)], ['zstd', zstdCompressSync(whole)]] as const) {
      const server = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(compressed.subarray(0, Math.floor(compressed.length / 2)));
        controller.close();
      } }), { headers: { 'content-encoding': encoding } }) });
      try {
        const failure = await settled(fetch(`http://127.0.0.1:${server.port}/`).then((response) => response.arrayBuffer()));
        expect(failure).not.toBeNull();
        expect(transientReadFailure(failure)).toBe(true);
      } finally { server.stop(true); }
    }
    const zlib = (code: string) => new TypeError('terminated', { cause: Object.assign(new Error('unexpected end of file'), { code }) });
    expect(transientReadFailure(zlib('Z_BUF_ERROR'))).toBe(true);
    expect(transientReadFailure(zlib('Z_DATA_ERROR'))).toBe(true);
  });

  it('judges a failure by the cause it carries, as Node reports a lost socket', () => {
    const socket = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code }) });
    expect(transientReadFailure(socket('UND_ERR_SOCKET'))).toBe(true);
    expect(transientReadFailure(socket('ECONNRESET'))).toBe(true);
    expect(transientReadFailure(socket('ENOSPC'))).toBe(false);
    expect(transientReadFailure(new TypeError('fetch failed'))).toBe(false);
  });
});

describe('the provider command failures a read may try again', () => {
  const failed = (stdout: string, stderr = '') => new CommandFailed('npx', ['--no-install', 'wrangler', 'd1'], { code: 1, stdout, stderr });
  /** What `wrangler d1 execute --json` prints when the API refuses a request with `code`. */
  const apiError = (note: string) => failed(JSON.stringify({ error: { text: 'A request to the Cloudflare API (/accounts/a/d1/database/d/query) failed.', notes: [{ text: note }] } }));

  it('tries again after the failures Wrangler prints for a lost connection, a timeout, a server error or a transient API code', () => {
    for (const failure of [
      failed('Downloading SQL to /tmp/d1.sql\n', '✘ [ERROR] fetch failed\n'),
      failed('', '✘ [ERROR] getaddrinfo ENOTFOUND api.cloudflare.com\n'),
      failed('', '✘ [ERROR] There was an error while downloading from the presigned URL with status code: 503\n'),
      failed('', '✘ [ERROR] Received a malformed response from the API\n\n  GET /accounts/a/d1/database -> 502 Bad Gateway\n'),
      apiError('The given account is not valid or is not authorized to access this service [code: 7403]'),
      apiError('Internal error [code: 10001]'),
      apiError('D1_ERROR: Network connection lost.'),
      new CommandTimedOut('npx', ['wrangler'], 60_000, 'ended'),
    ]) expect(transientReadFailure(failure)).toBe(true);
  });

  it('fails at once on an authentication error, a bad statement, or output that names no transient failure', () => {
    for (const failure of [
      apiError('Authentication error [code: 10000]'),
      apiError('near "SELEC": syntax error at offset 0 [code: 7500]'),
      failed('', '✘ [ERROR] Couldn\'t find a D1 DB with the name or binding \'myco-server\'\n'),
    ]) expect(transientReadFailure(failure)).toBe(false);
  });

  it('names the code a refusal of the account carries, whether it is retried or not', () => {
    expect(refusedAccountCode(apiError('The given account is not valid or is not authorized to access this service [code: 7403]'))).toBe('7403');
    expect(refusedAccountCode(new Error('wrapped', { cause: apiError('Authentication error [code: 10000]') }))).toBe('10000');
    expect(refusedAccountCode(apiError('Internal error [code: 10001]'))).toBeNull();
    expect(refusedAccountCode(new CommandTimedOut('npx', ['wrangler'], 60_000, 'ended'))).toBeNull();
  });
});
