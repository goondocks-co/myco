/**
 * The contract suite: one set of externally observable operations, run against
 * both deployment targets' adapter assemblies.
 *
 * WHAT THIS PROVES. Each operation is declared once and asserted identically on
 * both targets, so a behavior present on one and not the other fails here by name.
 * Independently exercised per target: the adapter assembly each entry point
 * produces, the platform descriptor and its error recognisers, and the blob store —
 * an in-memory one on the hosted side against a real directory on disk on the
 * self-hosted side.
 *
 * WHAT THIS DOES NOT PROVE. The hosted target's relational store and rate limiter
 * are test doubles: neither the hosted database nor its edge limiter can run in
 * this process, so both targets execute the same SQLite engine here. A difference
 * that only the real hosted database would show is therefore invisible to this
 * suite, and is proven instead by the live-edge smoke the release gate (#927) runs
 * against a deployed environment.
 *
 * This is the in-process half of the "one server product, two adapters" claim in
 * `docs/architecture/myco-2.0.md` §3.3.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { serverEnvFromBunConfig } from '@myco-server-worker/platform/bun/env.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { MAX_BLOB_BYTES, MIN_COMPAT_MEMBER_PROTOCOL, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { MAX_BODY_BYTES } from '@myco-server-worker/ingest/body.js';

import { blobPost, envelope, memberPost, sqliteEnv, TEXT_MEDIA_TYPE, uuid } from '../helpers/fixtures.js';
import { sha256HexOf, utf8 } from '@myco-server-worker/hash.js';

const temporaryRoots: string[] = [];
afterAll(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }); });

/** A seeded database on disk, so the self-hosted target runs against a real file rather than memory. */
function seededFile(): { sqlite: Database; blobDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'myco-contract-'));
  temporaryRoots.push(root);
  const sqlite = new Database(join(root, 'myco.sqlite'));
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
  sqlite.query(`INSERT INTO projects (project_id,name,created_at) VALUES ('proj_1','a',0),('proj_2','b',0)`).run();
  return { sqlite, blobDir: join(root, 'blobs') };
}

interface Target {
  name: string;
  env: ServerEnv;
  fetch(request: Request): Promise<Response>;
  token(): Promise<string>;
}

/**
 * Target W: the hosted adapter WIRING — the mapping, descriptor, and error
 * recognisers a deployed Worker gets — over a relational store and limiter that
 * stand in for the hosted ones, which cannot run in this process.
 */
function cloudflareTarget(): Target {
  const e = sqliteEnv();
  const env = serverEnvFromBindings(e.env as never);
  const server = createServer({ now: () => Date.now(), sourceOf: () => '1.2.3.4', fetchImpl: fetch });
  return {
    name: 'cloudflare',
    env,
    fetch: (request) => server.handleRequest(request, env),
    token: async () => (await issueMemberToken(env.db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now())).token,
  };
}

/** Target C: the self-hosted adapter set entire, over a real SQLite file and a real blob directory. */
function selfHostedTarget(): Target {
  const { sqlite, blobDir } = seededFile();
  const env = serverEnvFromBunConfig({ sqlite, blobDir });
  const server = createServer({ now: () => Date.now(), sourceOf: () => '1.2.3.4', fetchImpl: fetch });
  return {
    name: 'self-hosted',
    env,
    fetch: (request) => server.handleRequest(request, env),
    token: async () => (await issueMemberToken(env.db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now())).token,
  };
}

const json = async (res: Response) => res.json() as Promise<Record<string, unknown>>;

interface Outcome {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Runs one operation on both targets and returns each outcome. Every assertion
 * below checks the two against each other AND against an absolute expectation, so
 * the suite cannot pass by both targets being broken in the same way.
 */
async function onBoth(operation: (t: Target) => Promise<Response>): Promise<{ w: Outcome; c: Outcome }> {
  const run = async (t: Target): Promise<Outcome> => {
    const res = await operation(t);
    const contentType = res.headers.get('content-type') ?? '';
    return { status: res.status, body: contentType.includes('json') ? await json(res) : {} };
  };
  return { w: await run(W), c: await run(C) };
}

const W = cloudflareTarget();
const C = selfHostedTarget();
const TARGETS: Target[] = [W, C];

/** Asserts both targets produced the same outcome, and that it is the expected one. */
function agreeing({ w, c }: { w: Outcome; c: Outcome }, expected: Outcome): void {
  expect({ cloudflare: w, selfHosted: c }).toEqual({ cloudflare: expected, selfHosted: expected });
}

describe('one server product, two deployment targets', () => {
  it('serves health without a credential', async () => {
    const out = await onBoth((t) => t.fetch(new Request('https://s/health')));
    expect([out.w.status, out.c.status]).toEqual([200, 200]);
  });

  it('refuses an unauthenticated member route with 401 on both', async () => {
    const out = await onBoth((t) => t.fetch(new Request('https://s/events', { method: 'POST', body: '{}' })));
    agreeing(out, { status: 401, body: { error: 'unauthorized' } });
  });

  it('admits a prompt and projects it identically on both', async () => {
    const out = await onBoth(async (t) => t.fetch(memberPost(await t.token(), envelope())));
    agreeing(out, { status: 200, body: { persisted: true, projected: true } });
  });

  it('answers a replay as a duplicate identically on both', async () => {
    const tokens = new Map<string, string>();
    for (const t of TARGETS) tokens.set(t.name, await t.token());
    const replay = envelope({ eventId: uuid(41), payload: { promptId: uuid(42), text: 'replay', origin: 'user' } });
    await onBoth((t) => t.fetch(memberPost(tokens.get(t.name)!, replay)));
    const out = await onBoth((t) => t.fetch(memberPost(tokens.get(t.name)!, replay)));
    agreeing(out, { status: 200, body: { persisted: true, duplicate: true } });
  });

  it('refuses an unknown kind by name identically on both', async () => {
    const out = await onBoth(async (t) => t.fetch(memberPost(await t.token(), envelope({ kind: 'made.up', payload: {} }))));
    agreeing(out, { status: 200, body: { persisted: false, code: 'unknown_kind', reason: 'unknown kind made.up' } });
  });

  it('refuses an unknown payload field by name identically on both', async () => {
    const out = await onBoth(async (t) => t.fetch(memberPost(await t.token(), envelope({ eventId: uuid(9), extra: 1 }))));
    agreeing(out, { status: 200, body: { persisted: false, code: 'unknown_field', reason: 'unknown field extra' } });
  });

  it('stores a blob under its digest identically on both, and holds the bytes', async () => {
    const bytes = utf8('contract bytes');
    const key = await sha256HexOf(bytes);
    const out = await onBoth(async (t) => t.fetch(blobPost(await t.token(), key, bytes)));
    agreeing(out, { status: 200, body: { stored: true, duplicate: false, key, mediaType: TEXT_MEDIA_TYPE, size: bytes.byteLength } });
    for (const t of TARGETS) {
      expect({ target: t.name, size: (await t.env.blobs.head(`proj_1/${key}`))?.size ?? null })
        .toEqual({ target: t.name, size: bytes.byteLength });
    }
  });

  it('refuses bytes that do not match the declared digest identically on both, storing nothing', async () => {
    const bytes = utf8('these bytes');
    const wrongKey = await sha256HexOf(utf8('not these bytes'));
    const out = await onBoth(async (t) => t.fetch(blobPost(await t.token(), wrongKey, bytes)));
    agreeing(out, { status: 200, body: { stored: false, code: 'digest_mismatch', reason: 'digest mismatch' } });
    for (const t of TARGETS) {
      expect({ target: t.name, held: await t.env.blobs.head(`proj_1/${wrongKey}`) }).toEqual({ target: t.name, held: null });
    }
  });

  it('refuses a blob over the cap by name identically on both', async () => {
    const bytes = utf8('x');
    const key = await sha256HexOf(bytes);
    const out = await onBoth(async (t) => {
      const request = blobPost(await t.token(), key, bytes, TEXT_MEDIA_TYPE);
      const oversized = new Request(request.url, { method: 'POST', headers: request.headers, body: bytes });
      oversized.headers.set('content-length', String(MAX_BLOB_BYTES + 1));
      return t.fetch(oversized);
    });
    agreeing(out, { status: 200, body: { stored: false, code: 'blob_cap', reason: `blob exceeds ${MAX_BLOB_BYTES} bytes` } });
  });

  it('refuses a member outside the protocol window identically on both', async () => {
    const out = await onBoth(async (t) => {
      const request = memberPost(await t.token(), envelope());
      request.headers.set(PROTOCOL_HEADER, String(SERVER_PROTOCOL + 1));
      return t.fetch(request);
    });
    agreeing(out, {
      status: 409,
      body: { error: 'protocol_version_unsupported', server_protocol: SERVER_PROTOCOL, min_compat_member_protocol: MIN_COMPAT_MEMBER_PROTOCOL },
    });
  });

  it('refuses a token carrying no machine identity identically on both', async () => {
    const out = await onBoth(async (t) => {
      const token = (await issueMemberToken(t.env.db, { projectId: 'proj_1', machineId: null }, Date.now())).token;
      return t.fetch(memberPost(token, envelope()));
    });
    agreeing(out, { status: 200, body: { persisted: false, code: 'no_machine_identity', reason: 'token has no machine identity' } });
  });

  it('refuses an oversized body identically on both, without storing it', async () => {
    const out = await onBoth(async (t) =>
      t.fetch(memberPost(await t.token(), JSON.stringify({ ...envelope(), pad: 'x'.repeat(MAX_BODY_BYTES) }))));
    agreeing(out, { status: 200, body: { persisted: false, code: 'body_cap', reason: `body exceeds ${MAX_BODY_BYTES} bytes` } });
  });

  it('answers an authenticated member on an unmatched path identically on both', async () => {
    const out = await onBoth(async (t) => t.fetch(new Request('https://s/nope', { method: 'POST', headers: memberPost(await t.token(), '{}').headers, body: '{}' })));
    agreeing(out, { status: 401, body: { error: 'unauthorized' } });
  });

  it('names infrastructure it is missing, on both targets', () => {
    // The property `api/status.ts` exists to provide: a deployment that dropped a
    // required binding is NAMED here rather than answering a bare 503 at the first
    // request that happens to touch it.
    const hosted = serverEnvFromBindings({ BUCKET: undefined, SOURCE_LIMIT: {}, TOKEN_LIMIT: {}, MYCO_DB: {} } as never);
    expect(hosted.platform.missingBindings()).toEqual(['BUCKET']);

    const { sqlite } = seededFile();
    expect(serverEnvFromBunConfig({ sqlite, blobDir: '' }).platform.missingBindings()).toEqual(['MYCO_BLOB_DIR']);
    expect(serverEnvFromBunConfig({ sqlite: undefined as never, blobDir: '/tmp/x' }).platform.missingBindings()).toEqual(['MYCO_DATABASE']);

    // A handle that cannot answer a query is as missing as no handle at all.
    sqlite.close();
    expect(serverEnvFromBunConfig({ sqlite, blobDir: '/tmp/x' }).platform.missingBindings()).toEqual(['MYCO_DATABASE']);
  });

  it('reports its own required infrastructure, with none missing when configured', () => {
    for (const t of TARGETS) {
      expect({ target: t.name, missing: t.env.platform.missingBindings() }).toEqual({ target: t.name, missing: [] });
      expect(t.env.platform.requiredBindings.length).toBeGreaterThan(0);
    }
    // Each target names its own infrastructure in its own vocabulary.
    expect(W.env.platform.name).not.toBe(C.env.platform.name);
  });


});
