/**
 * Where the producer meets the outside: the one origin an account credential may reach, what a report may carry, and
 * how a wake keeps a Deployment alive while its own database is unreadable.
 */
import { expect, it } from 'bun:test';
import {
  armFloor, CONTINUATION_FLOOR_MS, soonestWake,
} from '@myco-server-worker/platform/cloudflare/deployment-clock.js';
import {
  CLOUDFLARE_API_ORIGIN, cloudflareProducerPorts, exportApiOrigin, transientStatus,
} from '@myco-server-worker/platform/cloudflare/recovery-export.js';
import { WAKE_CONTINUATIONS } from '@myco-server-worker/core/jobs.js';
import { TransientProducerFailure } from '@myco-server-worker/core/recovery-producer.js';

const TOKEN = 'account-token-value-not-a-real-credential';

const target = (apiOrigin?: string) => ({
  accountId: 'account-1', databaseId: 'database-1', tables: ['sessions'], token: TOKEN, ...(apiOrigin === undefined ? {} : { apiOrigin }),
});

/** The Deployment's own object store, which a recovery only ever reads. */
const source = () => ({ async get() { return null; } });

const bucket = () => ({
  async put() { return { size: 0 }; },
  async get() { return null; },
  async head() { return null; },
  async createMultipartUpload() { return { uploadId: 'u1' }; },
  resumeMultipartUpload() {
    return {
      async uploadPart() { return { etag: 'e1' }; },
      async complete() { return { size: 0 }; },
      async abort() {},
    };
  },
});

it('sends the account credential to the provider API and to nothing else', async () => {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
    if (String(input).startsWith(CLOUDFLARE_API_ORIGIN)) {
      return Response.json({ success: true, result: { status: 'complete', at_bookmark: 'b1', result: { signed_url: 'https://signed.example/one' } } });
    }
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 206, headers: { 'content-range': 'bytes 0-3/4', etag: 'w/"one"' },
    });
  }) as typeof fetch;
  try {
    const ports = cloudflareProducerPorts(target(), bucket(), source());
    const answer = await ports.pollExport(null);
    expect(answer.status).toBe('complete');
    await ports.readRange('https://signed.example/one', 0, 4);
  } finally { globalThis.fetch = original; }

  expect(seen).toHaveLength(2);
  expect(seen[0]!.url.startsWith(`${CLOUDFLARE_API_ORIGIN}/client/v4/accounts/account-1/d1/database/database-1/export`)).toBe(true);
  expect(seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  // The signed download is a capability of its own: it is fetched with no credential attached.
  expect(seen[1]!.url).toBe('https://signed.example/one');
  expect(seen[1]!.authorization).toBeNull();
});

it('refuses any export origin but the provider, unless a test runtime declares a loopback one', () => {
  expect(exportApiOrigin(target(), false)).toBe(CLOUDFLARE_API_ORIGIN);
  expect(exportApiOrigin(target('http://127.0.0.1:8123'), true)).toBe('http://127.0.0.1:8123');
  // A deployed Worker has no test routes, so even a loopback origin is refused there.
  expect(() => exportApiOrigin(target('http://127.0.0.1:8123'), false)).toThrow('other than the provider API is refused');
  for (const elsewhere of ['https://example.invalid', 'http://169.254.169.254', 'https://api.cloudflare.com.evil.test']) {
    expect(() => exportApiOrigin(target(elsewhere), true)).toThrow('other than the provider API is refused');
  }
});

it('treats a provider outage as worth another attempt and a refusal as final', () => {
  expect([408, 429, 500, 503].map(transientStatus)).toEqual([true, true, true, true]);
  expect([400, 401, 403, 404].map(transientStatus)).toEqual([false, false, false, false]);
});

it('carries no credential in what a provider failure reports', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 })) as typeof fetch;
  try {
    const answer = await cloudflareProducerPorts(target(), bucket(), source()).pollExport(null);
    // A refusal answers classified facts: a cause, a status, and whether another attempt is worth spending.
    expect(answer).toEqual({ status: 'error', bookmark: null, failure: { cause: 'http', status: 403, transient: false } });
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  } finally { globalThis.fetch = original; }
});

it('arms a floor before risky work, and never pushes an alarm that is already sooner', async () => {
  const arms: Array<number | null> = [];
  const store = (held: number | null) => ({
    async getAlarm() { return held; },
    async setAlarm(at: number) { arms.push(at); },
    async deleteAlarm() { arms.push(null); },
  });
  await armFloor(store(null), {}, 1_000);
  expect(arms).toEqual([1_000 + CONTINUATION_FLOOR_MS]);
  arms.length = 0;
  // An alarm already sooner than the floor stands.
  await armFloor(store(1_500), {}, 1_000);
  expect(arms).toEqual([]);
  // A later one is pulled in, so a wake that dies still returns soon.
  await armFloor(store(600_000), {}, 1_000);
  expect(arms).toEqual([1_000 + CONTINUATION_FLOOR_MS]);
  arms.length = 0;
  // A clock that keeps no alarm arms none.
  await armFloor(store(null), { CLOCK_MODE: 'manual' }, 1_000);
  expect(arms).toEqual([]);
});

it('takes the soonest deadline, and lets neither the tick nor a continuation cancel the other', () => {
  expect(soonestWake(60_000, 0)).toBe(0);
  expect(soonestWake(0, 60_000)).toBe(0);
  expect(soonestWake(60_000, null)).toBe(60_000);
  expect(soonestWake(null, 2_000)).toBe(2_000);
  // Deep sleep with nothing continuing is the only case that arms nothing.
  expect(soonestWake(null, null)).toBeNull();
});

it('declares the continuation, and states what it may never do', () => {
  expect(WAKE_CONTINUATIONS.map((continuation) => continuation.name)).toEqual(['recovery-export-continuation']);
  const [recovery] = WAKE_CONTINUATIONS;
  expect(recovery!.advances).toContain('already-admitted');
  for (const forbidden of ['admit an attempt', 'cadence', 'run the tick', 'dispatch']) {
    expect(recovery!.never).toContain(forbidden);
  }
});

it('treats an answer that stopped mid-body as a request worth another attempt', async () => {
  const original = globalThis.fetch;
  const cut = () => new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.error(new Error('the connection dropped')); },
  });
  try {
    // A ranged read whose headers arrived and whose body did not leaves the range unread, to be read again.
    globalThis.fetch = (async () => new Response(cut(), {
      status: 206, headers: { 'content-range': 'bytes 0-3/4', etag: 'w/"one"' },
    })) as unknown as typeof fetch;
    const range = await cloudflareProducerPorts(target(), bucket(), source()).readRange('https://signed.example/one', 0, 4);
    expect(range).toEqual({ status: 'error', failure: { cause: 'transport', status: null, transient: true } });

    // The same for the export request's own answer.
    globalThis.fetch = (async () => new Response(cut(), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const poll = await cloudflareProducerPorts(target(), bucket(), source()).pollExport(null);
    expect(poll).toEqual({ status: 'error', bookmark: null, failure: { cause: 'transport', status: null, transient: true } });

    // A body that arrived whole and is not the provider's protocol is the provider's answer, and ends the attempt.
    globalThis.fetch = (async () => new Response('<html>not json</html>', { status: 200 })) as unknown as typeof fetch;
    const malformed = await cloudflareProducerPorts(target(), bucket(), source()).pollExport(null);
    expect(malformed).toEqual({ status: 'error', bookmark: null, failure: { cause: 'provider', status: 200, transient: false } });

    // A request that never landed at all.
    globalThis.fetch = (async () => { throw new TypeError('network error'); }) as unknown as typeof fetch;
    expect(await cloudflareProducerPorts(target(), bucket(), source()).pollExport('b1'))
      .toEqual({ status: 'error', bookmark: 'b1', failure: { cause: 'transport', status: null, transient: true } });
  } finally { globalThis.fetch = original; }
});

it('spends a transient attempt on a staging store that is overloaded, and ends the attempt on one that refuses', async () => {
  const refusing = (message: string) => ({
    ...bucket(),
    async createMultipartUpload(): Promise<{ uploadId: string }> { throw new Error(message); },
    async put(): Promise<{ size: number }> { throw new Error(message); },
    async head(): Promise<{ size: number } | null> { throw new Error(message); },
    resumeMultipartUpload() {
      return {
        async uploadPart(): Promise<{ etag: string }> { throw new Error(message); },
        async complete(): Promise<{ size: number }> { throw new Error(message); },
        async abort(): Promise<void> { throw new Error(message); },
      };
    },
  });
  const parts = [{ part: 1, bytes: 4, sha256: 'a'.repeat(64), etag: 'e1' }];
  for (const worth of ['R2: internal error', 'Service Unavailable', 'GetObject: 503', 'connection reset by peer']) {
    const ports = cloudflareProducerPorts(target(), refusing(worth), source());
    for (const call of [
      () => ports.beginUpload('staging/1'),
      () => ports.writePart('staging/1', 'u1', 1, new Uint8Array(4), 4),
      () => ports.completeUpload('staging/1', 'u1', parts),
      () => ports.storedSize('staging/1'),
      () => ports.writeStagingFile('staging/1', 'recovery.json', '{}'),
    ]) {
      const raised = await call().then(() => null, (error: unknown) => error);
      expect({ worth, transient: raised instanceof TransientProducerFailure }).toEqual({ worth, transient: true });
      expect({ worth, failure: (raised as TransientProducerFailure).failure })
        .toEqual({ worth, failure: { cause: 'storage', status: null, transient: true } });
    }
  }
  // A refusal the store names for a reason of its own ends the attempt rather than being retried without end.
  const fatal = cloudflareProducerPorts(target(), refusing('the key is not a valid object name'), source());
  expect(await fatal.beginUpload('staging/1').then(() => null, (error: Error) => error.message)).toBe('the key is not a valid object name');
  // The interrupted completion still reconciles rather than retrying.
  const gone = cloudflareProducerPorts(target(), refusing('upload NoSuchUpload does not exist'), source());
  expect(await gone.completeUpload('staging/1', 'u1', parts)).toBeNull();
  // And a part that is not the length its range answered is this attempt's own failure.
  expect(await cloudflareProducerPorts(target(), bucket(), source()).writePart('staging/1', 'u1', 1, new Uint8Array(3), 4).then(() => null, (error: Error) => error.message))
    .toBe('a staged part is not the length its range answered');
});

it('refuses an answer whose success envelope carries a provider refusal', async () => {
  // HTTP 200, an outer success, an inner refusal, an error present, no status, no bookmark and no signed URL.
  const refusal = {
    success: true,
    result: { success: false, error: 'provider-controlled text that must not travel', at_bookmark: undefined },
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(refusal)) as typeof fetch;
  try {
    const ports = cloudflareProducerPorts(target(), bucket(), source());
    // Polling an export this attempt already holds a bookmark for.
    const held = await ports.pollExport('b1');
    expect(held.status).toBe('error');
    expect(JSON.stringify(held)).not.toContain('provider-controlled text');
    // And the first request of a fresh export.
    const fresh = await ports.pollExport(null);
    expect(fresh.status).toBe('error');
  } finally { globalThis.fetch = original; }
});

it('gives every provider call a deadline, and reports a request that never answers as worth another attempt', async () => {
  const original = globalThis.fetch;
  const signals: Array<AbortSignal | null | undefined> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    signals.push(init?.signal);
    // An answer that arrives only when the call's own deadline aborts it.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }) as unknown as typeof fetch;
  try {
    const ports = cloudflareProducerPorts(target(), bucket(), source(), { requestMs: 25 });
    const poll = await ports.pollExport('b1');
    expect(poll).toEqual({ status: 'error', bookmark: 'b1', failure: { cause: 'transport', status: null, transient: true } });
    const range = await ports.readRange('https://signed.example/one', 0, 4);
    expect(range).toEqual({ status: 'error', failure: { cause: 'transport', status: null, transient: true } });
  } finally { globalThis.fetch = original; }
  expect(signals.length).toBe(2);
  expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
});

/** A source body delivered in chunks, which records whether anyone cancelled it. */
function chunkedBody(total: number, chunk: number, fill = 7) {
  const held = { cancelled: false, delivered: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (held.delivered >= total) { controller.close(); return; }
      const size = Math.min(chunk, total - held.delivered);
      held.delivered += size;
      controller.enqueue(new Uint8Array(size).fill(fill));
    },
    cancel() { held.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, held };
}

/** A staging store whose write reads the stream it is given, the way a store write consumes a body. */
function consumingBucket(options: { refuse?: Error; readNothing?: boolean } = {}) {
  const writes: Array<{ key: string; bytes: number; sha256?: string; stream: boolean }> = [];
  return {
    writes,
    bucket: {
      ...bucket(),
      async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, putOptions?: { sha256?: string }) {
        const stream = body instanceof ReadableStream;
        if (options.readNothing === true) return { size: 0 };
        let bytes = 0;
        if (stream) {
          const reader = (body as ReadableStream<Uint8Array>).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (options.refuse !== undefined && bytes > 0) throw options.refuse;
          }
        }
        writes.push({ key, bytes, sha256: putOptions?.sha256, stream });
        return { size: bytes };
      },
    },
  };
}

it('streams a legacy object that records no digest, of any size, and measures the digest of what it wrote', async () => {
  const total = 64 * 1024 * 1024 + 1;
  const { body, held } = chunkedBody(total, 1024 * 1024);
  const store = consumingBucket();
  const ports = cloudflareProducerPorts(target(), store.bucket, { async get() { return { body, size: total }; } });
  const answer = await ports.copyObject('staging/1', { key: 'backups/legacy.jsonl', source: 'backups/legacy.jsonl' }, { bytes: total, sha256: null }, new AbortController().signal);

  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256');
  for (let at = 0; at < total; at += 1024 * 1024) expected.update(new Uint8Array(Math.min(1024 * 1024, total - at)).fill(7));
  expect(answer).toEqual({ status: 'copied', sha256: expected.digest('hex'), bytes: total });
  // The write took a stream under the objects directory, never a body held whole, and no size ceiling applied.
  expect(store.writes).toEqual([{ key: 'staging/1/objects/backups/legacy.jsonl', bytes: total, sha256: undefined, stream: true }]);
  expect(held.cancelled).toBe(false);
});

it('refuses a source that is not the size its row records before writing, and releases its body', async () => {
  const { body, held } = chunkedBody(10, 4);
  const store = consumingBucket();
  const ports = cloudflareProducerPorts(target(), store.bucket, { async get() { return { body, size: 10 }; } });
  const answer = await ports.copyObject('staging/1', { key: 'backups/one.jsonl', source: 'backups/one.jsonl' }, { bytes: 9, sha256: null }, new AbortController().signal);
  expect(answer).toEqual({ status: 'error', failure: { cause: 'provider', status: null, transient: false } });
  expect([store.writes.length, held.cancelled, held.delivered]).toEqual([0, true, 0]);
});

it('refuses a body that carries more bytes than it declared, as the bytes arrive', async () => {
  // The store answers a size the body then outruns: the meter stops it past the declared length.
  const { body, held } = chunkedBody(64, 16);
  const store = consumingBucket();
  const ports = cloudflareProducerPorts(target(), store.bucket, { async get() { return { body, size: 32 }; } });
  const answer = await ports.copyObject('staging/1', { key: 'backups/one.jsonl', source: 'backups/one.jsonl' }, { bytes: 32, sha256: null }, new AbortController().signal);
  expect(answer).toEqual({ status: 'error', failure: { cause: 'provider', status: null, transient: false } });
  expect(held.delivered).toBeLessThanOrEqual(48);
  expect(held.cancelled).toBe(true);
});

it('releases the body when a write returns without reading it, or refuses the digest', async () => {
  const unread = chunkedBody(8, 4);
  const lazy = consumingBucket({ readNothing: true });
  const skipped = await cloudflareProducerPorts(target(), lazy.bucket, { async get() { return { body: unread.body, size: 8 }; } })
    .copyObject('staging/1', { key: `proj_1/${'a'.repeat(64)}`, source: `proj_1/${'a'.repeat(64)}` }, { bytes: 8, sha256: 'a'.repeat(64) }, new AbortController().signal);
  expect(skipped).toEqual({ status: 'error', failure: { cause: 'provider', status: null, transient: false } });
  expect(unread.held.cancelled).toBe(true);

  const refusedBody = chunkedBody(8, 4);
  const refusing = consumingBucket({ refuse: new Error('put: The SHA-256 checksum you specified did not match what we received. (10037)') });
  const refused = await cloudflareProducerPorts(target(), refusing.bucket, { async get() { return { body: refusedBody.body, size: 8 }; } })
    .copyObject('staging/1', { key: `proj_1/${'a'.repeat(64)}`, source: `proj_1/${'a'.repeat(64)}` }, { bytes: 8, sha256: 'a'.repeat(64) }, new AbortController().signal);
  expect(refused).toEqual({ status: 'error', failure: { cause: 'provider', status: null, transient: false } });
  expect(refusedBody.held.cancelled).toBe(true);
});

it('stops streaming and releases the source when the caller stops waiting', async () => {
  const { body, held } = chunkedBody(64 * 1024 * 1024, 64 * 1024);
  const controller = new AbortController();
  const store = consumingBucket();
  const slowGet = { async get() { return { body, size: 64 * 1024 * 1024 }; } };
  const ports = cloudflareProducerPorts(target(), store.bucket, slowGet);
  const copying = ports.copyObject('staging/1', { key: 'backups/big.jsonl', source: 'backups/big.jsonl' }, { bytes: 64 * 1024 * 1024, sha256: null }, controller.signal);
  controller.abort(new DOMException('the caller stopped waiting', 'AbortError'));
  await copying.catch(() => undefined);
  expect(held.cancelled).toBe(true);
  expect(held.delivered).toBeLessThan(64 * 1024 * 1024);
  expect(store.writes).toEqual([]);
});
