import { describe, it, expect } from 'bun:test';
import worker from '../../packages/myco-server/worker/src/index.js';
import { createServer } from '../../packages/myco-server/worker/src/pipeline.js';
import { mintMemberToken } from '../../packages/myco-server/worker/src/auth/tokens.js';
import { MEMBER_TOKEN_BYTE_QUOTA, RETRY_AFTER_SECONDS, SERVER_SCHEMA_VERSION } from '../../packages/myco-server/worker/src/constants.js';
import { sha256Hex } from '../../packages/myco-server/worker/src/hash.js';
import { createIngestThrottle } from './helpers/throttle.js';

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
  const row = {
    id: 'mt_1', project_id: 'proj_1', machine_id: 'machine_1',
    token_hash: await sha256Hex(token),
    expires_at: opts.expiresAt ?? Date.now() + 1_000_000,
    revoked_at: opts.revokedAt ?? null,
    bytes_written: opts.bytesWritten ?? 0,
    schema_version: opts.schemaVersion === undefined ? String(SERVER_SCHEMA_VERSION) : opts.schemaVersion,
  };
  const statement = () => ({
    first: async () => { if (opts.authThrows) throw new Error('D1_ERROR: boom'); return null; },
    run: async () => { if (opts.writeThrows) throw new Error('D1_ERROR: boom'); return { meta: { changes: 1 } }; },
  });
  return {
    MYCO_DB: {
      prepare: (sql: string) => ({
        ...statement(),
        bind: (h: string) => ({
          ...statement(),
          first: async () => {
            if (opts.authThrows) throw new Error('D1_ERROR: boom');
            return sql.includes('member_tokens') && h === row.token_hash ? row : null;
          },
        }),
      }),
      batch: async (stmts: unknown[]) => { if (opts.writeThrows) throw new Error('D1_ERROR: boom'); return stmts.map(() => ({ meta: { changes: 1 } })); },
    },
    SOURCE_LIMIT: opts.sourceLimitThrows ? { limit: async () => { throw new Error('limiter down'); } } : createIngestThrottle(opts.sourceLimit ?? 100, 60_000, 100, () => 0),
    TOKEN_LIMIT: opts.tokenLimitThrows ? { limit: async () => { throw new Error('limiter down'); } } : createIngestThrottle(opts.tokenLimit ?? 100, 60_000, 100, () => 0),
  } as any;
}

const good = { eventId: 'evt_1', sessionId: 'sess_1', kind: 'prompt', createdAt: 1_000, transport: 'cli', payload: { t: 'hi' } };

const post = (token?: string, opts: { source?: string | null; body?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.source !== null) headers['cf-connecting-ip'] = opts.source ?? '1.2.3.4';
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

  it('answers 503 when a limiter throws', async () => {
    const token = mintMemberToken();
    expect((await worker.fetch(post(), await envFor(token, { sourceLimitThrows: true }))).status).toBe(503);
    expect((await worker.fetch(post(token), await envFor(token, { tokenLimitThrows: true }))).status).toBe(503);
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
    const noSource = streamed({ authorization: `Bearer ${token}` });
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
    const req = new Request('https://s/events', { method: 'POST', body, headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '1.2.3.4' }, duplex: 'half' } as any);
    const res = await worker.fetch(req, await envFor(token));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ persisted: false, reason: 'unavailable' });
  });

  it('answers 503 when the database schema version is not this build\'s, before any write', async () => {
    const token = mintMemberToken();
    expect((await worker.fetch(post(token), await envFor(token, { schemaVersion: '999', writeThrows: true }))).status).toBe(503);
    expect((await worker.fetch(post(token), await envFor(token, { schemaVersion: null, writeThrows: true }))).status).toBe(503);
  });

  it('accepts the bearer scheme in any letter case', async () => {
    const token = mintMemberToken();
    const env = await envFor(token);
    for (const scheme of ['bearer', 'BEARER', 'Bearer']) {
      const req = new Request('https://s/events', { method: 'POST', body: JSON.stringify(good), headers: { authorization: `${scheme} ${token}`, 'cf-connecting-ip': '1.2.3.4' } });
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

  it('takes source identity from the injected adapter', async () => {
    const server = createServer({ now: () => Date.now(), sourceOf: () => 'shared' });
    const env = await envFor(mintMemberToken(), { sourceLimit: 1 });
    await server.handleRequest(post(mintMemberToken(), { source: '1.1.1.1' }), env);
    const res = await server.handleRequest(post(mintMemberToken(), { source: '2.2.2.2' }), env);
    expect(res.status).toBe(429);
  });
});
