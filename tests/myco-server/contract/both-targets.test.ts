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
import { migrateAndSeed } from '../helpers/d1.js';
import { titleSession } from '@myco-server-worker/core/titling.js';
import { listSessions, renameProject } from '@myco-server-worker/read/sessions.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { MAX_BLOB_BYTES, MAX_PROJECTS, MIN_COMPAT_MEMBER_PROTOCOL, PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { MAX_BODY_BYTES } from '@myco-server-worker/ingest/body.js';
import { getRunDetail, listRuns } from '@myco-server-worker/read/runs.js';
import { issueExternalGrant, revokeExternalGrant } from '@myco-server-worker/auth/grants.js';
import { externalDefinitions } from '@myco-server-worker/mcp/external.js';

import { blobPost, envelope, memberPost, sqliteEnv, TEXT_MEDIA_TYPE, uuid } from '../helpers/fixtures.js';
import { sha256HexOf, utf8 } from '@myco-server-worker/hash.js';

const temporaryRoots: string[] = [];
afterAll(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }); });

/** A seeded database on disk, so the self-hosted target runs against a real file rather than memory. */
function seededFile(): { sqlite: Database; blobDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'myco-contract-'));
  temporaryRoots.push(root);
  const sqlite = migrateAndSeed(new Database(join(root, 'myco.sqlite')));
  return { sqlite, blobDir: join(root, 'blobs') };
}

interface Target {
  name: string;
  env: ServerEnv;
  fetch(request: Request): Promise<Response>;
  token(): Promise<string>;
  /** Resolves once every piece of work a request deferred past its answer has settled. */
  settle(): Promise<void>;
}

/**
 * Target W: the hosted adapter WIRING — the mapping, descriptor, and error
 * recognisers a deployed Worker gets — over a relational store and limiter that
 * stand in for the hosted ones, which cannot run in this process.
 */
function cloudflareTarget(outbound?: typeof fetch): Target {
  const e = sqliteEnv();
  const env: ServerEnv = { ...serverEnvFromBindings(e.env as never, e.deferred), ...(outbound === undefined ? {} : { outbound }) };
  const server = createServer({ now: () => Date.now(), sourceOf: () => '1.2.3.4', fetchImpl: fetch });
  return {
    name: 'cloudflare',
    env,
    fetch: (request) => server.handleRequest(request, env),
    token: async () => (await issueMemberToken(env.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now())).token,
    settle: e.deferred.settle,
  };
}

/** Target C: the self-hosted adapter set entire, over a real SQLite file and a real blob directory. */
function selfHostedTarget(outbound?: typeof fetch): Target {
  const { sqlite, blobDir } = seededFile();
  const base = serverEnvFromBunConfig({ sqlite, blobDir });
  const env: ServerEnv = { ...base, ...(outbound === undefined ? {} : { outbound }) };
  const server = createServer({ now: () => Date.now(), sourceOf: () => '1.2.3.4', fetchImpl: fetch });
  return {
    name: 'self-hosted',
    env,
    settle: base.settle,
    fetch: (request) => server.handleRequest(request, env),
    token: async () => (await issueMemberToken(env.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now())).token,
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

/** Capability ids a platform reports as not present, for cross-target comparison. */
const absentIds = (caps: { capability: string; present: boolean }[]): string[] =>
  caps.filter((c) => !c.present).map((c) => c.capability).sort();

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
      const token = (await issueMemberToken(t.env.db, { memberId: 'mem_anon', machineId: null }, Date.now())).token;
      return t.fetch(memberPost(token, envelope()));
    });
    agreeing(out, { status: 200, body: { persisted: false, code: 'no_machine_identity', reason: 'token has no machine identity' } });
  });

  it('refuses an oversized body identically on both, without storing it', async () => {
    const out = await onBoth(async (t) =>
      t.fetch(memberPost(await t.token(), JSON.stringify({ ...envelope(), pad: 'x'.repeat(MAX_BODY_BYTES) }))));
    agreeing(out, { status: 200, body: { persisted: false, code: 'body_cap', reason: `body exceeds ${MAX_BODY_BYTES} bytes` } });
  });

  it('resolves a Project neither target has seen, identically on both, and admits the event into it', async () => {
    // `resolveProject` decides on `meta.changes` from an `INSERT ... SELECT ... WHERE`,
    // and each target computes that in its own adapter — Cloudflare from D1's own
    // metadata, self-hosted from whether bun:sqlite reports the statement as producing
    // rows. A statement that inserts nothing and one that inserts a row must be
    // distinguishable the same way on both, or one target creates Projects the other
    // refuses.
    const out = await onBoth(async (t) => t.fetch(memberPost(await t.token(), envelope(), '/events', { [PROJECT_HEADER]: 'proj_unseen' })));
    agreeing(out, { status: 200, body: { persisted: true, projected: true } });
  });

  it('refuses past the Project ceiling identically on both, once each target is full', async () => {
    const out = await onBoth(async (t) => {
      const held = (await t.env.db.prepare(`SELECT COUNT(*) AS c FROM projects`).first<{ c: number }>())!.c;
      const rows = Array.from({ length: MAX_PROJECTS - held }, (_, i) => `('fill_${i}','fill_${i}',0)`).join(',');
      await t.env.db.prepare(`INSERT INTO projects (project_id, name, created_at) VALUES ${rows}`).run();
      return t.fetch(memberPost(await t.token(), envelope(), '/events', { [PROJECT_HEADER]: 'proj_over' }));
    });
    agreeing(out, { status: 503, body: { persisted: false, code: 'unavailable', reason: 'unavailable' } });
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
    expect(absentIds(hosted.platform.capabilities())).toEqual(['blob-store', 'harness-runtime']);

    const { sqlite } = seededFile();
    expect(absentIds(serverEnvFromBunConfig({ sqlite, blobDir: '' }).platform.capabilities())).toEqual(['blob-store', 'harness-runtime']);
    expect(absentIds(serverEnvFromBunConfig({ sqlite: undefined as never, blobDir: '/tmp/x' }).platform.capabilities())).toEqual(['harness-runtime', 'relational-store']);

    // A handle that cannot answer a query is as missing as no handle at all.
    sqlite.close();
    expect(absentIds(serverEnvFromBunConfig({ sqlite, blobDir: '/tmp/x' }).platform.capabilities())).toEqual(['harness-runtime', 'relational-store']);
  });

  it('states the same capabilities on both targets, with none absent when configured', () => {
    for (const t of TARGETS) {
      const caps = t.env.platform.capabilities();
      // Neither contract target binds a harness runtime; that one capability is absent on both, by the same name.
      expect({ target: t.name, absent: absentIds(caps) }).toEqual({ target: t.name, absent: ['harness-runtime'] });
      // The set is identical across targets, which is what lets one sentence
      // describe either one.
      expect({ target: t.name, ids: caps.map((c) => c.capability).sort() })
        .toEqual({ target: t.name, ids: ['blob-store', 'harness-runtime', 'rate-limiting', 'relational-store'] });
      // Same wording, whichever target is answering.
      expect({ target: t.name, labels: caps.map((c) => c.label).sort() })
        .toEqual({ target: t.name, labels: ['Blob storage', 'Harness runtime', 'Project storage', 'Request rate limiting'] });
    }
    // Each target names its own infrastructure in its own vocabulary.
    expect(W.env.platform.name).not.toBe(C.env.platform.name);
  });


});

import { authenticateServerMemberToken } from '@myco-server-worker/auth/tokens.js';
import { authenticateGrant, issueExternalGrant, rotateExternalGrant } from '@myco-server-worker/auth/grants.js';
import { revokeMember } from '@myco-server-worker/auth/members-admin.js';
import { sha256Hex } from '@myco-server-worker/hash.js';

describe('access administration agrees on both stores', () => {
  it('offboards a member in one transaction and rotates a grant atomically, with the same outcomes on each target', async () => {
    const outcomes: Record<string, unknown>[] = [];
    for (const t of TARGETS) {
      const now = Date.now();
      const token = await t.token();
      const credential = (await issueMemberToken(t.env.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, now)).token;
      const revoked = await revokeMember(t.env.db, 'mem_machine_2', 'mem_machine_1', now);
      const afterRevoke = await authenticateServerMemberToken(t.env.db, await sha256Hex(credential), now + 1);
      const grant = await issueExternalGrant(t.env.db, { projectId: 'proj_1' }, 'bot', 'mem_machine_1', now);
      const rotated = await rotateExternalGrant(t.env.db, { projectId: 'proj_1' }, grant.id, 'mem_machine_1', now + 1);
      const foreign = await rotateExternalGrant(t.env.db, { projectId: 'proj_2' }, rotated!.id, 'mem_machine_1', now + 2);
      outcomes.push({
        revoked, afterRevoke,
        oldKey: await authenticateGrant(t.env.db, await sha256Hex(grant.key)),
        newKey: (await authenticateGrant(t.env.db, await sha256Hex(rotated!.key)))?.projectId,
        foreign,
        stillLive: (await authenticateServerMemberToken(t.env.db, await sha256Hex(token), now + 1)) !== null,
      });
    }
    expect(outcomes[0]).toEqual({ revoked: { ok: true }, afterRevoke: null, oldKey: null, newKey: 'proj_1', foreign: null, stillLive: true });
    expect(outcomes[1]).toEqual(outcomes[0]);
  });
});

describe('agent runs read the same on both stores', () => {
  it('lists a failed run as failed and opens it with its record and phases, identically on each target', async () => {
    const checkpoints = JSON.stringify({ schemaVersion: 2, harness: 'h', providerConfig: { type: 'openai', apiKey: 'sk-canary' }, phases: { prepare: { name: 'prepare', status: 'completed', updatedAt: 5, turnsUsed: 2 }, write: { status: 'failed', updatedAt: 6, capHit: true, summary: 'ran out of turns' } } });
    const outcomes: unknown[] = [];
    for (const t of TARGETS) {
      await t.env.db.prepare(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_c', 'c', 'built-in', 1, 1)`).run();
      await t.env.db.prepare(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, error, checkpoints, execution_overrides, resume_status, resumable)
        VALUES ('proj_1', 'run_c', 'agent_c', 'digest', 'failed', 1000, 2000, 'boom', ?, '{"provider":{"apiKey":"sk-canary"}}', 'session_expired', 1)`).bind(checkpoints).run();
      const listed = await listRuns(t.env.db, { projectId: 'proj_1' });
      const detail = await getRunDetail(t.env.db, { projectId: 'proj_1' }, 'run_c');
      const foreign = await getRunDetail(t.env.db, { projectId: 'proj_2' }, 'run_c');
      outcomes.push({ listed, detail, foreign, leaks: /sk-canary|providerConfig/.test(JSON.stringify({ listed, detail })) });
    }
    expect(outcomes[0]).toEqual({
      listed: { rows: [{ id: 'run_c', agentId: 'agent_c', task: 'digest', status: 'failed', provider: null, model: null, startedAt: 1000, resumedAt: null, completedAt: 2000, tokensUsed: null, costUsd: null, costSource: null, dryRun: false, resumable: true, resumeStatus: 'session_expired', failed: true, queuedAt: null, heldBy: null, position: null, replaced: false, replaces: null }], cursor: null },
      detail: {
        run: { id: 'run_c', agentId: 'agent_c', task: 'digest', status: 'failed', provider: null, model: null, startedAt: 1000, resumedAt: null, completedAt: 2000, tokensUsed: null, costUsd: null, costSource: null, dryRun: false, resumable: true, resumeStatus: 'session_expired', failed: true, queuedAt: null, heldBy: null, position: null, replaced: false, replaces: null, instruction: null, sessionRef: null, actualCostUsd: null, estimatedCostUsd: null, reasoningLevel: null, resumeMode: null, resumeAttempts: 0, error: 'boom', dispatchedBy: null, usageData: null, actionsTaken: null },
        phases: [
          { name: 'prepare', status: 'completed', updatedAt: 5, summary: null, turnsUsed: 2, allowedMaxTurns: null, tokensUsed: null, costUsd: null, costSource: null, capHit: false, semanticCheckBlocked: false, postConditionFailed: false },
          { name: 'write', status: 'failed', updatedAt: 6, summary: 'ran out of turns', turnsUsed: null, allowedMaxTurns: null, tokensUsed: null, costUsd: null, costSource: null, capHit: true, semanticCheckBlocked: false, postConditionFailed: false },
        ],
      },
      foreign: null,
      leaks: false,
    });
    expect(outcomes[1]).toEqual(outcomes[0]);
  });
});

describe('archival refuses capture the same on both stores', () => {
  it('answers an ended session\'s titling the same on each target with no runtime bound — nothing stamped, no outbound call, the label from its first prompt — and renames its project', async () => {
    const outcomes: unknown[] = [];
    for (const make of [cloudflareTarget, selfHostedTarget]) {
      const sent: string[] = [];
      const outbound = (async (input: string | URL | Request, init?: RequestInit) => {
        sent.push(`${String(input)} ${(init?.headers as Record<string, string> | undefined)?.authorization ?? 'no-credential'}`);
        return new Response('unexpected', { status: 500 });
      }) as unknown as typeof fetch;
      const t = make(outbound);
      const token = await t.token();
      const post = async (over: Record<string, unknown>) => json(await t.fetch(memberPost(token, envelope(over))));
      const scope = { projectId: 'proj_1' };
      const row = async (id: string) => (await listSessions(t.env.db, scope, { sessionId: id })).rows[0];
      const settings = async (rows: Array<[string, string]>) => {
        await t.env.db.prepare(`DELETE FROM deployment_settings`).run();
        for (const [leaf, value] of rows) await t.env.db.prepare(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, 1, 'mem_1')`).bind(leaf, JSON.stringify(value)).run();
      };
      await settings([['agent.provider.type', 'openai-compatible'], ['agent.provider.model', 'local-model'], ['agent.provider.base_url', 'http://titles.internal/v1']]);

      expect((await post({ eventId: uuid(300), sessionId: 'sess_t', kind: 'session.start', payload: { agent: 'claude-code', branch: 'main', startedAt: 1_000 } })).persisted).toBe(true);
      expect((await post({ eventId: uuid(301), sessionId: 'sess_t', payload: { promptId: uuid(310), text: 'Add a retry to the runner\nplease', origin: 'user' } })).persisted).toBe(true);
      const labelBefore = (await row('sess_t'))?.label;
      const beforeEnd = (await titleSession(t.env, { projectId: 'proj_1', sessionId: 'sess_t', now: 5_000, origin: 'https://s' })).outcome;
      expect(await post({ eventId: uuid(302), sessionId: 'sess_t', kind: 'session.end', createdAt: 6_000, payload: { endedAt: 6_000 } })).toEqual({ persisted: true, projected: true });
      await t.settle();
      const titled = await row('sess_t');
      expect(await post({ eventId: uuid(303), sessionId: 'sess_t', kind: 'session.end', createdAt: 7_000, payload: { endedAt: 7_000 } })).toEqual({ persisted: true, projected: true });
      await t.settle();
      const sentAfterSecondEnd = sent.length;

      await settings([]);
      expect((await post({ eventId: uuid(320), sessionId: 'sess_n', kind: 'session.start', payload: { agent: 'codex', startedAt: 1_000 } })).persisted).toBe(true);
      expect((await post({ eventId: uuid(321), sessionId: 'sess_n', payload: { promptId: uuid(330), text: 'No provider here', origin: 'user' } })).persisted).toBe(true);
      expect((await post({ eventId: uuid(322), sessionId: 'sess_n', kind: 'session.end', createdAt: 8_000, payload: { endedAt: 8_000 } })).projected).toBe(true);
      await t.settle();
      const unprovided = await row('sess_n');

      const renamed = await renameProject(t.env.db, 'proj_1', 'Myco');
      const absent = await renameProject(t.env.db, 'proj_nobody', 'Nobody');
      outcomes.push({
        labelBefore, beforeEnd, title: titled?.title, summary: titled?.summary, label: titled?.label, attempted: titled?.titledAt !== null,
        sent, sentAfterSecondEnd, unprovided: { attempted: unprovided?.titledAt !== null, title: unprovided?.title, label: unprovided?.label }, renamed, absent,
      });
    }
    const expected = {
      labelBefore: 'Add a retry to the runner', beforeEnd: 'harness_unavailable', title: null, summary: null, label: 'Add a retry to the runner', attempted: false,
      sent: [], sentAfterSecondEnd: 0,
      unprovided: { attempted: false, title: null, label: 'No provider here' }, renamed: 'renamed', absent: 'absent',
    };
    expect({ cloudflare: outcomes[0], selfHosted: outcomes[1] }).toEqual({ cloudflare: expected, selfHosted: expected });
  });

  it('answers the named terminal refusal in the route shape on each target, and restores after unarchive', async () => {
    for (const t of TARGETS) await t.env.db.prepare(`UPDATE projects SET archived_at = 1, archived_by = 'mem_machine_1' WHERE project_id = 'proj_1'`).run();
    const refused = await onBoth(async (t) => t.fetch(memberPost(await t.token(), envelope({ eventId: uuid(71) }))));
    agreeing(refused, { status: 200, body: { persisted: false, code: 'project_archived', reason: 'this project is archived on the server; unarchive it from the dashboard to resume capture' } });
    for (const t of TARGETS) await t.env.db.prepare(`UPDATE projects SET archived_at = NULL, archived_by = NULL WHERE project_id = 'proj_1'`).run();
    const restored = await onBoth(async (t) => t.fetch(memberPost(await t.token(), envelope({ eventId: uuid(72) }))));
    agreeing(restored, { status: 200, body: { persisted: true, projected: true } });
  });
});

describe('an External Agent grant reads the same on both stores', () => {
  it('lists the read-only surface, answers a read, refuses a write as a tool that does not exist, and refuses a revoked grant with 401, identically on each target', async () => {
    const keys = new Map<Target, { key: string; id: string }>();
    for (const t of TARGETS) keys.set(t, await issueExternalGrant(t.env.db, { projectId: 'proj_1' }, 'bot', 'mem_machine_1', Date.now()));
    const rpc = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });
    const over = (t: Target, body: string) => new Request('https://s/mcp', { method: 'POST', headers: { authorization: `Bearer ${keys.get(t)!.key}` }, body });
    const listed = await onBoth((t) => t.fetch(over(t, rpc('tools/list'))));
    agreeing(listed, { status: 200, body: JSON.parse(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: externalDefinitions().map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema, annotations: d.annotations })) } })) });
    const read = await onBoth((t) => t.fetch(over(t, rpc('tools/call', { name: 'myco_plans', arguments: { op: 'list' } }))));
    agreeing(read, { status: 200, body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '[]' }], structuredContent: { result: [] } } } });
    const write = await onBoth((t) => t.fetch(over(t, rpc('tools/call', { name: 'myco_spores', arguments: { op: 'save', type: 'gotcha', content: 'x' } }))));
    agreeing(write, { status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Unknown tool: myco_spores', data: { code: 'unknown_tool' } } } });
    for (const t of TARGETS) await revokeExternalGrant(t.env.db, { projectId: 'proj_1' }, keys.get(t)!.id, 'mem_machine_1', Date.now());
    const revoked = await onBoth((t) => t.fetch(over(t, rpc('tools/list'))));
    agreeing(revoked, { status: 401, body: { error: 'unauthorized' } });
  });
});
