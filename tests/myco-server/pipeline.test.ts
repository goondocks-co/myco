import { describe, it, expect } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { mintMemberToken } from '@myco-server-worker/auth/tokens.js';
import { MAX_BLOB_BYTES, MEMBER_TOKEN_BYTE_QUOTA, MIN_COMPAT_MEMBER_PROTOCOL, PROTOCOL_HEADER, RETRY_AFTER_SECONDS, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { createIngestThrottle } from './helpers/throttle.js';
import { authRow, noMemberRow } from './helpers/rows.js';
import { blobPost, envelope, memoryBlobStore, PROTOCOL } from './helpers/fixtures.js';

interface EnvOpts {
  sourceLimit?: number;
  tokenLimit?: number;
  authThrows?: boolean;
  writeThrows?: boolean;
  expiresAt?: number;
  revokedAt?: number | null;
  bytesWritten?: number;
  sourceLimitThrows?: boolean;
  tokenLimitThrows?: boolean;
  schemaVersion?: string | null;
}

async function envFor(token: string, opts: EnvOpts = {}) {
  const tokenHash = await sha256Hex(token);
  const version = opts.schemaVersion === undefined ? undefined : { schema_version: opts.schemaVersion };
  const member = authRow({
    expires_at: opts.expiresAt ?? Date.now() + 1_000_000,
    revoked_at: opts.revokedAt ?? null,
    bytes_written: opts.bytesWritten ?? 0,
    ...version,
  });
  const nobody = noMemberRow({ ...version });
  const statement = () => ({
    first: async () => { if (opts.authThrows) throw new Error('D1_ERROR: boom'); return null; },
    run: async () => { if (opts.writeThrows) throw new Error('D1_ERROR: boom'); return { results: [], meta: { changes: 1 } }; },
  });
  return {
    MYCO_DB: {
      prepare: (sql: string) => ({
        ...statement(),
        bind: (h: string) => ({
          ...statement(),
          first: async () => {
            if (opts.authThrows) throw new Error('D1_ERROR: boom');
            if (!sql.includes('schema_meta')) return null;
            if (opts.schemaVersion === null) return null;
            return h === tokenHash ? member : nobody;
          },
        }),
      }),
      batch: async (stmts: unknown[]) => { if (opts.writeThrows) throw new Error('D1_ERROR: boom'); return stmts.map(() => ({ results: [], meta: { changes: 1 } })); },
    },
    BUCKET: memoryBlobStore(),
    SOURCE_LIMIT: opts.sourceLimitThrows ? { limit: async () => { throw new Error('limiter down'); } } : createIngestThrottle(opts.sourceLimit ?? 100, 60_000, 100, () => 0),
    TOKEN_LIMIT: opts.tokenLimitThrows ? { limit: async () => { throw new Error('limiter down'); } } : createIngestThrottle(opts.tokenLimit ?? 100, 60_000, 100, () => 0),
  } as any;
}

const good = envelope();

const post = (token?: string, opts: { source?: string | null; body?: string; protocol?: string | null } = {}) => {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.source !== null) headers['cf-connecting-ip'] = opts.source ?? '1.2.3.4';
  if (opts.protocol !== null) headers[PROTOCOL_HEADER] = opts.protocol ?? String(SERVER_PROTOCOL);
  return new Request('https://s/events', { method: 'POST', body: opts.body ?? JSON.stringify(good), headers });
};

describe('pipeline (via the deployed entry)', () => {
  it('serves the public route with no credential', async () => {
    expect((await worker.fetch(new Request('https://s/health'), {} as any)).status).toBe(200);
  });

  it('answers 401 for an unmatched path, not 404', async () => {
    const res = await worker.fetch(new Request('https://s/nope', { headers: { 'cf-connecting-ip': '1.2.3.4' } }), await envFor(mintMemberToken()));
    expect(res.status).toBe(401);
  });

  it('answers 401 to an authenticated member on an unmatched path without charging the source bucket', async () => {
    const token = mintMemberToken();
    const env = await envFor(token, { sourceLimit: 1 });
    for (let i = 0; i < 3; i++) {
      const res = await worker.fetch(new Request('https://s/nope', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '1.2.3.4', ...PROTOCOL } }), env);
      expect(res.status).toBe(401);
    }
    expect((await worker.fetch(post(), env)).status).toBe(401);
    expect((await worker.fetch(post(), env)).status).toBe(429);
  });

  it('answers 401 with no credential and with a wrong one', async () => {
    const env = await envFor(mintMemberToken());
    expect((await worker.fetch(post(), env)).status).toBe(401);
    expect((await worker.fetch(post(mintMemberToken()), env)).status).toBe(401);
  });

  it('answers 401 for a malformed credential without a token lookup', async () => {
    const token = mintMemberToken();
    const env = await envFor(token);
    let prepares = 0;
    const db = env.MYCO_DB;
    env.MYCO_DB = { ...db, prepare: (sql: string) => { prepares += 1; return db.prepare(sql); } };
    for (const bad of [`${token}x`, token.slice(0, 42), 'not a token', `${token.slice(0, 42)}!`]) {
      expect((await worker.fetch(post(bad), env)).status).toBe(401);
    }
    expect(prepares).toBe(0);
  });

  it('answers 401 for an expired and for a revoked token', async () => {
    const token = mintMemberToken();
    expect((await worker.fetch(post(token), await envFor(token, { expiresAt: 1 }))).status).toBe(401);
    expect((await worker.fetch(post(token), await envFor(token, { revokedAt: 1 }))).status).toBe(401);
  });

  it('answers 503 when the request carries no source identity', async () => {
    const token = mintMemberToken();
    const res = await worker.fetch(post(token, { source: null }), await envFor(token));
    expect(res.status).toBe(503);
  });

  it('rate-limits anonymous failures by source and never refuses an authenticated member by source', async () => {
    const token = mintMemberToken();
    const env = await envFor(token, { sourceLimit: 2 });
    expect((await worker.fetch(post(), env)).status).toBe(401);
    expect((await worker.fetch(post(mintMemberToken()), env)).status).toBe(401);
    const exhausted = await worker.fetch(post(mintMemberToken()), env);
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers.get('retry-after')).toBeTruthy();
    expect((await worker.fetch(post(), env)).status).toBe(429);
    expect((await worker.fetch(post(token), env)).status).toBe(200);
    expect((await worker.fetch(post(mintMemberToken()), env)).status).toBe(429);
  });

  it('never charges the source bucket for an authenticated member', async () => {
    const token = mintMemberToken();
    const env = await envFor(token, { sourceLimit: 1 });
    for (let i = 0; i < 3; i++) expect((await worker.fetch(post(token), env)).status).toBe(200);
    expect((await worker.fetch(post(), env)).status).toBe(401);
    expect((await worker.fetch(post(), env)).status).toBe(429);
  });

  it('answers 503 when a limiter throws: bare before authentication, and after it in the route\'s shape with the protocol header', async () => {
    const token = mintMemberToken();
    const anonymous = await worker.fetch(post(), await envFor(token, { sourceLimitThrows: true }));
    expect({ status: anonymous.status, body: await anonymous.json(), protocol: anonymous.headers.get(PROTOCOL_HEADER) }).toEqual({ status: 503, body: { error: 'unavailable' }, protocol: null });
    const events = await worker.fetch(post(token), await envFor(token, { tokenLimitThrows: true }));
    expect({ status: events.status, body: await events.json(), protocol: events.headers.get(PROTOCOL_HEADER), retry: events.headers.get('retry-after') })
      .toEqual({ status: 503, body: { persisted: false, reason: 'unavailable' }, protocol: String(SERVER_PROTOCOL), retry: String(RETRY_AFTER_SECONDS) });
    const blobs = await worker.fetch(blobPost(token, 'b'.repeat(64), new Uint8Array([1])), await envFor(token, { tokenLimitThrows: true }));
    expect({ status: blobs.status, body: await blobs.json(), protocol: blobs.headers.get(PROTOCOL_HEADER) })
      .toEqual({ status: 503, body: { stored: false, reason: 'unavailable' }, protocol: String(SERVER_PROTOCOL) });
    const unmatched = await worker.fetch(new Request('https://s/nope', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '1.2.3.4', ...PROTOCOL } }), await envFor(token, { tokenLimitThrows: true }));
    expect({ status: unmatched.status, body: await unmatched.json(), protocol: unmatched.headers.get(PROTOCOL_HEADER) }).toEqual({ status: 503, body: { error: 'unavailable' }, protocol: String(SERVER_PROTOCOL) });
  });

  it('names the bearer scheme on 401', async () => {
    const res = await worker.fetch(post(), await envFor(mintMemberToken()));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="myco"');
  });

  it('rate-limits by token id only after authentication', async () => {
    const token = mintMemberToken();
    const env = await envFor(token, { tokenLimit: 1 });
    const samePrefix = () => `${token.slice(0, 16)}${mintMemberToken().slice(16)}`;
    expect((await worker.fetch(post(samePrefix()), env)).status).toBe(401);
    expect((await worker.fetch(post(samePrefix()), env)).status).toBe(401);
    expect((await worker.fetch(post(token), env)).status).toBe(200);
    expect((await worker.fetch(post(token), env)).status).toBe(429);
  });

  it('leaves the request stream untouched on every pre-handler refusal', async () => {
    const token = mintMemberToken();
    const streamed = (headers: Record<string, string>) => {
      const state = { cancelled: false };
      const body = new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { state.cancelled = true; } });
      return { req: new Request('https://s/events', { method: 'POST', body, headers, duplex: 'half' } as any), state };
    };
    const noCred = streamed({ 'cf-connecting-ip': '1.2.3.4' });
    expect((await worker.fetch(noCred.req, await envFor(token))).status).toBe(401);
    const noSource = streamed({ authorization: `Bearer ${token}`, ...PROTOCOL });
    expect((await worker.fetch(noSource.req, await envFor(token))).status).toBe(503);
    const throttled = streamed({ 'cf-connecting-ip': '1.2.3.4' });
    expect((await worker.fetch(throttled.req, await envFor(token, { sourceLimit: 0 }))).status).toBe(429);
    for (const s of [noCred, noSource, throttled]) expect({ cancelled: s.state.cancelled, used: s.req.bodyUsed }).toEqual({ cancelled: false, used: false });
  });

  it('turns an auth-path infrastructure failure into 503, never 500', async () => {
    const token = mintMemberToken();
    const res = await worker.fetch(post(token), await envFor(token, { authThrows: true }));
    expect(res.status).toBe(503);
  });

  it('turns a post-auth storage failure into a retryable 503 with a reason, never 200 and never 500', async () => {
    const token = mintMemberToken();
    const res = await worker.fetch(post(token), await envFor(token, { writeThrows: true }));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe(String(RETRY_AFTER_SECONDS));
    expect(await res.json()).toEqual({ persisted: false, reason: 'unavailable' });
  });

  it('turns a post-auth body stream failure into a retryable 503 with a reason', async () => {
    const token = mintMemberToken();
    const body = new ReadableStream({ pull() { throw new Error('client went away'); } });
    const req = new Request('https://s/events', { method: 'POST', body, headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '1.2.3.4', ...PROTOCOL }, duplex: 'half' } as any);
    const res = await worker.fetch(req, await envFor(token));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ persisted: false, reason: 'unavailable' });
  });

  it('answers 503 when the database schema version is not this build\'s, before any write and before any token decision', async () => {
    const token = mintMemberToken();
    expect((await worker.fetch(post(token), await envFor(token, { schemaVersion: '999', writeThrows: true }))).status).toBe(503);
    expect((await worker.fetch(post(token), await envFor(token, { schemaVersion: null, writeThrows: true }))).status).toBe(503);
    expect((await worker.fetch(post(mintMemberToken()), await envFor(token, { schemaVersion: '999' }))).status).toBe(503);
    expect((await worker.fetch(post(mintMemberToken()), await envFor(token, { schemaVersion: null }))).status).toBe(503);
  });

  it('logs failed authentication with a digest of the source, never the address', async () => {
    const token = mintMemberToken();
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => { lines.push(s); };
    try {
      await worker.fetch(post(mintMemberToken(), { source: '203.0.113.7' }), await envFor(token));
    } finally { console.log = orig; }
    const failed = lines.map((l) => JSON.parse(l)).find((e) => e.kind === 'auth_failed');
    expect(failed).toBeDefined();
    expect(failed.source).toBe((await sha256Hex('203.0.113.7')).slice(0, 16));
    expect(JSON.stringify(failed)).not.toContain('203.0.113.7');
  });

  it('answers a constraint failure as a quota refusal only when the token is at quota, otherwise 503, on the json route and the stream route alike', async () => {
    const token = mintMemberToken();
    const constraintEnv = async (bytesWritten: number) => {
      const env = await envFor(token, { bytesWritten: 0 });
      const db = env.MYCO_DB;
      env.MYCO_DB = {
        ...db,
        prepare: (sql: string) => {
          if (sql.includes('SELECT bytes_written FROM member_tokens')) return { bind: () => ({ first: async () => ({ bytes_written: bytesWritten }) }) };
          return db.prepare(sql);
        },
        batch: async () => { throw new Error('D1_ERROR: SQLITE_CONSTRAINT_CHECK'); },
      };
      return env;
    };
    const blob = () => blobPost(token, 'b'.repeat(64), new Uint8Array([1, 2]));
    for (const [route, request, shape] of [['events', post, 'persisted'], ['blobs', blob, 'stored']] as const) {
      const atQuota = await worker.fetch(request(token), await constraintEnv(MEMBER_TOKEN_BYTE_QUOTA - 1));
      expect({ route, status: atQuota.status, body: await atQuota.json() }).toEqual({ route, status: 200, body: { [shape]: false, reason: 'token write quota exceeded' } });
      const under = await worker.fetch(request(token), await constraintEnv(0));
      expect({ route, status: under.status, body: await under.json() }).toEqual({ route, status: 503, body: { [shape]: false, reason: 'unavailable' } });
    }
  });

  it('accepts the bearer scheme in any letter case', async () => {
    const token = mintMemberToken();
    const env = await envFor(token);
    for (const scheme of ['bearer', 'BEARER', 'Bearer']) {
      const req = new Request('https://s/events', { method: 'POST', body: JSON.stringify(good), headers: { authorization: `${scheme} ${token}`, 'cf-connecting-ip': '1.2.3.4', ...PROTOCOL } });
      expect((await worker.fetch(req, env)).status).toBe(200);
    }
  });

  it('refuses a write past the token byte quota before touching storage', async () => {
    const token = mintMemberToken();
    const res = await worker.fetch(post(token), await envFor(token, { bytesWritten: MEMBER_TOKEN_BYTE_QUOTA - 1, writeThrows: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ persisted: false, reason: 'token write quota exceeded' });
  });

  it('stamps security headers on 200, 401, 429, and 503', async () => {
    const token = mintMemberToken();
    const responses = [
      await worker.fetch(new Request('https://s/health'), {} as any),
      await worker.fetch(post(), await envFor(token)),
      await worker.fetch(post(token, { source: null }), await envFor(token)),
    ];
    const limitedEnv = await envFor(token, { sourceLimit: 0 });
    responses.push(await worker.fetch(post(), limitedEnv));
    expect(responses.map((r) => r.status)).toEqual([200, 401, 503, 429]);
    for (const res of responses) {
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('answers 409 with the supported range to a member outside the protocol window, after authentication', async () => {
    const token = mintMemberToken();
    const env = await envFor(token);
    for (const bad of [null, '', '0', String(SERVER_PROTOCOL + 1), '1.5', 'one', '1a', '+1']) {
      const res = await worker.fetch(post(token, { protocol: bad }), env);
      expect({ bad, status: res.status }).toEqual({ bad, status: 409 });
      expect(await res.json()).toEqual({ error: 'protocol_version_unsupported', server_protocol: SERVER_PROTOCOL, min_compat_member_protocol: MIN_COMPAT_MEMBER_PROTOCOL });
      expect(res.headers.get(PROTOCOL_HEADER)).toBe(String(SERVER_PROTOCOL));
    }
    expect((await worker.fetch(post(undefined, { protocol: null }), env)).status).toBe(401);
    expect((await worker.fetch(post(mintMemberToken(), { protocol: '999' }), env)).status).toBe(401);
    expect((await worker.fetch(post(token), env)).status).toBe(200);
  });

  it('charges the token limiter for a mis-versioned member, so a wedged member is rate-limited', async () => {
    const token = mintMemberToken();
    const env = await envFor(token, { tokenLimit: 2 });
    expect((await worker.fetch(post(token, { protocol: null }), env)).status).toBe(409);
    expect((await worker.fetch(post(token, { protocol: null }), env)).status).toBe(409);
    expect((await worker.fetch(post(token, { protocol: null }), env)).status).toBe(429);
  });

  it('answers 409 to a well-formed member request whose protocol is below the minimum', async () => {
    const token = mintMemberToken();
    const env = await envFor(token);
    expect(MIN_COMPAT_MEMBER_PROTOCOL).toBeGreaterThanOrEqual(1);
    const res = await worker.fetch(post(token, { protocol: String(MIN_COMPAT_MEMBER_PROTOCOL - 1) }), env);
    expect(res.status).toBe(409);
    expect((await worker.fetch(post(token), env)).status).toBe(200);
  });

  it('refuses a stream route without content-length or over its cap before touching the body, and stamps the protocol header on every response', async () => {
    const token = mintMemberToken();
    const env = await envFor(token);
    const key = 'b'.repeat(64);
    const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
    const noLength = new Request(`https://s/blobs/${key}`, { method: 'POST', body, headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '1.2.3.4', 'content-type': 'text/plain', ...PROTOCOL }, duplex: 'half' } as any);
    const res = await worker.fetch(noLength, env);
    expect(await res.json()).toEqual({ stored: false, reason: 'content-length required' });
    expect(res.headers.get(PROTOCOL_HEADER)).toBe(String(SERVER_PROTOCOL));
    expect({ used: noLength.bodyUsed, locked: noLength.body?.locked }).toEqual({ used: false, locked: false });
    const big = new Request(`https://s/blobs/${key}`, { method: 'POST', body: new Uint8Array(8), headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '1.2.3.4', 'content-type': 'text/plain', 'content-length': String(MAX_BLOB_BYTES + 1), ...PROTOCOL } });
    expect(await (await worker.fetch(big, env)).json()).toEqual({ stored: false, reason: `blob exceeds ${MAX_BLOB_BYTES} bytes` });
    for (const bad of ['-1', '1.5', 'x']) {
      const req = new Request(`https://s/blobs/${key}`, { method: 'POST', body: new Uint8Array(8), headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '1.2.3.4', 'content-type': 'text/plain', 'content-length': bad, ...PROTOCOL } });
      expect(await (await worker.fetch(req, env)).json()).toEqual({ stored: false, reason: 'content-length required' });
    }
  });

  it('discloses the protocol number only to authenticated members: never on /health or a 401', async () => {
    const env = await envFor(mintMemberToken());
    const health = await worker.fetch(new Request('https://s/health'), env);
    expect(health.headers.get(PROTOCOL_HEADER)).toBeNull();
    const anonymous = await worker.fetch(post(), env);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get(PROTOCOL_HEADER)).toBeNull();
    const wrong = await worker.fetch(post(mintMemberToken()), env);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get(PROTOCOL_HEADER)).toBeNull();
  });

  it('takes source identity from the injected adapter', async () => {
    const server = createServer({ now: () => Date.now(), sourceOf: () => 'shared' });
    const env = await envFor(mintMemberToken(), { sourceLimit: 1 });
    await server.handleRequest(post(mintMemberToken(), { source: '1.1.1.1' }), env);
    const res = await server.handleRequest(post(mintMemberToken(), { source: '2.2.2.2' }), env);
    expect(res.status).toBe(429);
  });
});
