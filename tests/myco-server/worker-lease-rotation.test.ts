import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueMemberToken, revokeMemberLineage } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { serverEnvFromBunConfig } from '@myco-server-worker/platform/bun/env.js';
import { expireLeases } from '@myco-server-worker/core/harness.js';
import { projectRepositories } from '@myco-server-worker/core/repositories.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { WORKER_LEASE_MS } from '@myco-server-worker/constants.js';
import { REPOSITORY_CHECKOUT_CAPABILITY } from '@goondocks/myco-shared/repository';
import { memberPost, sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { offeredHarness } from './helpers/offered-harness.js';
import type { PreparedStatement } from '@myco-server-worker/core/adapters.js';

const RUN = { projectId: 'proj_1', runId: 'run_rotation' };
const SOURCE = { url: 'https://example.test/team/source', branch: 'main' };
const WRAP_KEY = btoa('r'.repeat(32));
const OPERATIONS = [
  { path: '/worker/lease', body: {}, expected: { held: true } },
  { path: '/worker/repository', body: { ...SOURCE, commit: 'a'.repeat(40) }, expected: { held: true } },
  { path: '/worker/end', body: { status: 'failed' }, expected: { ended: true } },
] as const;

async function rig(target: 'cloudflare' | 'bun') {
  const e = sqliteEnv({ workerLogin: true });
  const root = mkdtempSync(join(tmpdir(), 'myco-lease-rotation-'));
  let now = Date.now();
  e.env.SECRET_WRAP_KEY = { get: async () => WRAP_KEY };
  const env = target === 'bun'
    ? serverEnvFromBunConfig({ sqlite: e.sqlite, blobDir: join(root, 'blobs'), SECRET_WRAP_KEY: WRAP_KEY, now: () => now })
    : e.serverEnv;
  turnOnGatedCapabilities(e.sqlite);
  await ensureMember(env.db, 'mem_worker', now, 'admin', 'worker');
  await ensureMember(env.db, 'mem_other_worker', now, 'admin', 'other worker');
  const owner = await issueMemberToken(env.db, { memberId: 'mem_worker', machineId: 'machine_worker' }, now);
  await projectRepositories(env.db, deploymentSecretStore(env.db, env.wrappingKey))
    .save(RUN.projectId, { ...SOURCE, revision: null, credential: null }, 'mem_worker', now);
  e.sqlite.run(`INSERT INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,?)`, [now]);
  e.sqlite.run(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context)
    VALUES (?,?, 'myco-agent','vault-seed','queued',?,'worker',?,'{}')`,
  [RUN.projectId, RUN.runId, now, JSON.stringify({ serverUrl: 'https://s', actor: 'mem_worker' })]);
  const server = createServer({ now: () => now, sourceOf: () => '1.2.3.4', fetchImpl: fetch });
  const post = async (token: string, path: string, body: unknown) => {
    const response = await server.handleRequest(memberPost(token, body, path), env);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const claim = async (token: string) => {
    const result = await post(token, '/worker/claim', {
      harnesses: [offeredHarness('claude-code')], capabilities: [REPOSITORY_CHECKOUT_CAPABILITY],
    });
    expect(result.body).toMatchObject({ persisted: true, claimed: true });
    return (result.body.run as { attemptId: string }).attemptId;
  };
  const rotate = async (token: string, tokenId: string) => {
    e.sqlite.run('UPDATE member_credentials SET expires_at=? WHERE id=?', [now + 60_000, tokenId]);
    const result = await post(token, '/tokens/refresh', {});
    expect(result).toMatchObject({ status: 200, body: { refreshed: true } });
    return result.body as { token: string; tokenId: string };
  };
  const row = () => e.sqlite.query('SELECT status, leased_by AS leasedBy, dispatched_by AS attemptId, lease_expires_at AS leaseExpiresAt FROM agent_runs WHERE id=?')
    .get(RUN.runId) as { status: string; leasedBy: string; attemptId: string; leaseExpiresAt: number | null };
  return { e, env, owner, post, claim, rotate, row,
    advance: (ms: number) => { now += ms; }, clock: () => now,
    close: () => { e.sqlite.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function pauseAuthenticatedOwner(r: Awaited<ReturnType<typeof rig>>) {
  const prior = r.env.tokenLimit;
  let release = () => {};
  let reached = () => {};
  const admitted = new Promise<void>((resolve) => { reached = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  r.env.tokenLimit = { limit: async (input) => {
    if (input.key === r.owner.tokenId) { reached(); await paused; }
    return prior.limit(input);
  } };
  return { admitted, resume: release, restore: () => { release(); r.env.tokenLimit = prior; } };
}

function pauseStatement(r: Awaited<ReturnType<typeof rig>>, match: string) {
  const prepare = r.env.db.prepare.bind(r.env.db);
  let release = () => {};
  let reached = () => {};
  const admitted = new Promise<void>((resolve) => { reached = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  const wrap = (statement: PreparedStatement, sql: string): PreparedStatement => ({
    bind: (...params) => wrap(statement.bind(...params), sql),
    first: () => statement.first(), all: () => statement.all(),
    run: async () => {
      if (!held && sql.includes(match)) { held = true; reached(); await paused; }
      return statement.run();
    },
  });
  r.env.db.prepare = (sql) => sql.includes(match) ? wrap(prepare(sql), sql) : prepare(sql);
  return { admitted, resume: release, restore: () => { release(); r.env.db.prepare = prepare; } };
}

for (const target of ['cloudflare', 'bun'] as const) describe(`${target}: authenticated worker lease rotation`, () => {
  for (const operation of OPERATIONS) it(`keeps authenticated ${operation.path} valid when activation overtakes it`, async () => {
      const r = await rig(target);
      let pause: ReturnType<typeof pauseAuthenticatedOwner> | undefined;
      try {
        const attemptId = await r.claim(r.owner.token);
        const next = await r.rotate(r.owner.token, r.owner.tokenId);
        pause = pauseAuthenticatedOwner(r);
        const pending = r.post(r.owner.token, operation.path, { ...RUN, attemptId, ...operation.body });
        await pause.admitted;
        r.advance(1_000);
        expect((await r.post(next.token, '/worker/lease', { ...RUN, attemptId })).body).toMatchObject({ held: true });
        expect(r.row()).toMatchObject({ leasedBy: next.tokenId });
        const later = await r.rotate(next.token, next.tokenId);
        expect((await r.post(later.token, '/worker/lease', { ...RUN, attemptId })).body).toMatchObject({ held: true });
        pause.resume();
        expect(await pending).toMatchObject({ status: 200, body: operation.expected });
        expect(r.row()).toMatchObject({ leasedBy: later.tokenId });
        if (operation.path === '/worker/lease') expect(r.row().leaseExpiresAt).toBe(r.clock() + WORKER_LEASE_MS);
        expect(await r.post(r.owner.token, operation.path, { ...RUN, attemptId, ...operation.body })).toMatchObject({ status: 401 });
      } finally { pause?.restore(); r.close(); }
  });

  for (const operation of OPERATIONS.filter((operation) => operation.path !== '/worker/lease')) {
    it(`keeps ${operation.path} valid when activation overtakes its final guarded write`, async () => {
      const r = await rig(target);
      let pause: ReturnType<typeof pauseStatement> | undefined;
      try {
        const attemptId = await r.claim(r.owner.token);
        const next = await r.rotate(r.owner.token, r.owner.tokenId);
        pause = pauseStatement(r, operation.path === '/worker/repository'
          ? "UPDATE agent_runs SET run_context = json_set" : 'completed_at = ?');
        const pending = r.post(r.owner.token, operation.path, { ...RUN, attemptId, ...operation.body });
        await pause.admitted;
        expect((await r.post(next.token, '/worker/lease', { ...RUN, attemptId })).body).toMatchObject({ held: true });
        pause.resume();
        expect((await pending).body).toMatchObject(operation.expected);
        expect(r.row()).toMatchObject({ leasedBy: next.tokenId });
      } finally { pause?.restore(); r.close(); }
    });
  }

  it('requires member, machine and lineage matches even for live authenticated credentials', async () => {
    const r = await rig(target);
    try {
      const attemptId = await r.claim(r.owner.token);
      for (const identity of [
        { memberId: 'mem_other_worker', machineId: 'machine_worker', lineage: r.owner.tokenId },
        { memberId: 'mem_worker', machineId: 'machine_other', lineage: r.owner.tokenId },
        { memberId: 'mem_worker', machineId: 'machine_worker', lineage: 'another_lineage' },
      ]) {
        const token = await issueMemberToken(r.env.db, identity, r.clock());
        r.e.sqlite.run('UPDATE member_credentials SET lineage_root=? WHERE id=?', [identity.lineage, token.tokenId]);
        for (const operation of OPERATIONS) {
          expect((await r.post(token.token, operation.path, { ...RUN, attemptId, ...operation.body })).body)
            .toMatchObject(operation.path === '/worker/end' ? { ended: false } : { held: false });
        }
      }
      expect(r.row()).toMatchObject({ status: 'running', leasedBy: r.owner.tokenId });
    } finally { r.close(); }
  });

  it('refuses separately revoked callers, lease owners and members after authentication', async () => {
    for (const refusal of ['caller', 'holder', 'member', 'successor-proof', 'expired-holder'] as const) {
      for (const operation of OPERATIONS) {
        const r = await rig(target);
        let pause: ReturnType<typeof pauseAuthenticatedOwner> | undefined;
        try {
          const attemptId = await r.claim(r.owner.token);
          const next = await r.rotate(r.owner.token, r.owner.tokenId);
          pause = pauseAuthenticatedOwner(r);
          const pending = r.post(r.owner.token, operation.path, { ...RUN, attemptId, ...operation.body });
          await pause.admitted;
          expect((await r.post(next.token, '/worker/lease', { ...RUN, attemptId })).body).toMatchObject({ held: true });
          if (refusal === 'caller') r.e.sqlite.run('UPDATE member_credentials SET revoked_by=? WHERE id=?', ['mem_worker', r.owner.tokenId]);
          if (refusal === 'holder') r.e.sqlite.run('UPDATE member_credentials SET revoked_at=?, revoked_by=? WHERE id=?', [r.clock(), 'mem_worker', next.tokenId]);
          if (refusal === 'member') r.e.sqlite.run('UPDATE members SET revoked_at=? WHERE id=?', [r.clock(), 'mem_worker']);
          if (refusal === 'successor-proof') r.e.sqlite.run('UPDATE member_credentials SET first_used_at=NULL WHERE id=?', [next.tokenId]);
          if (refusal === 'expired-holder') r.e.sqlite.run('UPDATE member_credentials SET expires_at=? WHERE id=?', [r.clock(), next.tokenId]);
          pause.resume();
          expect((await pending).body).toMatchObject(operation.path === '/worker/end' ? { ended: false } : { held: false });
          expect(r.row()).toMatchObject({ status: 'running', leasedBy: next.tokenId });
        } finally { pause?.restore(); r.close(); }
      }
    }
  });

  it('refuses an authenticated request whose lineage is explicitly revoked before its lease write', async () => {
    for (const operation of OPERATIONS) {
      const r = await rig(target);
      let pause: ReturnType<typeof pauseAuthenticatedOwner> | undefined;
      try {
        const attemptId = await r.claim(r.owner.token);
        const next = await r.rotate(r.owner.token, r.owner.tokenId);
        pause = pauseAuthenticatedOwner(r);
        const pending = r.post(r.owner.token, operation.path, { ...RUN, attemptId, ...operation.body });
        await pause.admitted;
        expect((await r.post(next.token, '/worker/lease', { ...RUN, attemptId })).body).toMatchObject({ held: true });
        await revokeMemberLineage(r.env.db, next.tokenId, r.clock(), 'mem_worker');
        pause.resume();
        expect((await pending).body).toMatchObject(operation.path === '/worker/end' ? { ended: false } : { held: false });
        expect(r.row()).toMatchObject({ status: 'running', leasedBy: next.tokenId });
      } finally { pause?.restore(); r.close(); }
    }
  });

  it('activates a successor, renews, prepares source access and closes the same attempt', async () => {
    const r = await rig(target);
    try {
      const attemptId = await r.claim(r.owner.token);
      const next = await r.rotate(r.owner.token, r.owner.tokenId);
      expect(r.row()).toMatchObject({ leasedBy: r.owner.tokenId, attemptId });
      expect(await r.post(next.token, '/worker/lease', { ...RUN, attemptId }))
        .toMatchObject({ status: 200, body: { persisted: true, held: true } });
      expect(r.row()).toMatchObject({ leasedBy: next.tokenId, attemptId, status: 'running' });
      expect(await r.post(r.owner.token, '/worker/lease', { ...RUN, attemptId })).toMatchObject({ status: 401 });
      expect(await r.post(next.token, '/worker/repository', { ...RUN, attemptId }))
        .toMatchObject({ status: 200, body: { persisted: true, held: true, repository: SOURCE } });
      expect(await r.post(next.token, '/worker/end', { ...RUN, attemptId, status: 'failed', error: 'fixture failure' }))
        .toMatchObject({ status: 200, body: { persisted: true, ended: true } });
      expect(r.row()).toMatchObject({ leasedBy: next.tokenId, status: 'failed' });
      const later = await r.rotate(next.token, next.tokenId);
      await r.post(later.token, '/worker/lease', { ...RUN, attemptId });
      expect(r.row()).toMatchObject({ leasedBy: next.tokenId, status: 'failed' });
    } finally { r.close(); }
  });

  it('refuses other lineages, members and machines at every worker operation', async () => {
    const r = await rig(target);
    try {
      const attemptId = await r.claim(r.owner.token);
      const next = await r.rotate(r.owner.token, r.owner.tokenId);
      await r.post(next.token, '/worker/lease', { ...RUN, attemptId });
      for (const identity of [
        { memberId: 'mem_worker', machineId: 'machine_worker' },
        { memberId: 'mem_other_worker', machineId: 'machine_worker' },
        { memberId: 'mem_worker', machineId: 'machine_other' },
      ]) {
        const unrelated = await issueMemberToken(r.env.db, identity, r.clock());
        expect((await r.post(unrelated.token, '/worker/lease', { ...RUN, attemptId })).body).toMatchObject({ held: false });
        expect((await r.post(unrelated.token, '/worker/repository', { ...RUN, attemptId })).body).toMatchObject({ held: false });
        expect((await r.post(unrelated.token, '/worker/end', { ...RUN, attemptId, status: 'failed' })).body).toMatchObject({ ended: false });
      }
      expect(r.row()).toMatchObject({ leasedBy: next.tokenId, status: 'running', attemptId });
    } finally { r.close(); }
  });

  it('keeps earlier attempts fenced through another rotation and never rescues expired leases', async () => {
    const r = await rig(target);
    try {
      const first = await r.claim(r.owner.token);
      const next = await r.rotate(r.owner.token, r.owner.tokenId);
      r.advance(WORKER_LEASE_MS);
      expect((await r.post(next.token, '/worker/lease', { ...RUN, attemptId: first })).body).toMatchObject({ held: false });
      expect(r.row()).toMatchObject({ leasedBy: r.owner.tokenId });
      expect(await expireLeases(r.env, r.clock())).toBe(1);
      const second = await r.claim(next.token);
      expect(second).not.toBe(first);
      const later = await r.rotate(next.token, next.tokenId);
      expect((await r.post(later.token, '/worker/lease', { ...RUN, attemptId: first })).body).toMatchObject({ held: false });
      expect((await r.post(later.token, '/worker/repository', { ...RUN, attemptId: first })).body).toMatchObject({ held: false });
      expect((await r.post(later.token, '/worker/end', { ...RUN, attemptId: first, status: 'failed' })).body).toMatchObject({ ended: false });
      expect((await r.post(later.token, '/worker/lease', { ...RUN, attemptId: second })).body).toMatchObject({ held: true });
      expect((await r.post(later.token, '/worker/end', { ...RUN, attemptId: second, status: 'failed' })).body).toMatchObject({ ended: true });
    } finally { r.close(); }
  });

  it('refuses an expired attempt while its current rotated worker credential remains live', async () => {
    const r = await rig(target);
    try {
      const attemptId = await r.claim(r.owner.token);
      const next = await r.rotate(r.owner.token, r.owner.tokenId);
      expect((await r.post(next.token, '/worker/lease', { ...RUN, attemptId })).body).toMatchObject({ held: true });
      r.advance(WORKER_LEASE_MS);
      for (const operation of OPERATIONS) {
        expect((await r.post(next.token, operation.path, { ...RUN, attemptId, ...operation.body })).body)
          .toMatchObject(operation.path === '/worker/end' ? { ended: false } : { held: false });
      }
      expect(r.row()).toMatchObject({ leasedBy: next.tokenId, status: 'running' });
    } finally { r.close(); }
  });

  it('requires the stored successor to retain its predecessor member, machine and lineage', async () => {
    for (const [column, value] of [
      ['member_id', 'mem_other_worker'],
      ['machine_id', 'machine_other'],
      ['lineage_root', 'another_lineage'],
    ] as const) {
      const r = await rig(target);
      try {
        const attemptId = await r.claim(r.owner.token);
        const next = await r.rotate(r.owner.token, r.owner.tokenId);
        r.e.sqlite.run(`UPDATE member_credentials SET ${column}=? WHERE id=?`, [value, next.tokenId]);
        expect((await r.post(next.token, '/worker/lease', { ...RUN, attemptId })).body).toMatchObject({ held: false });
        expect(r.row()).toMatchObject({ leasedBy: r.owner.tokenId, status: 'running', attemptId });
      } finally { r.close(); }
    }
  });

  it('never transfers stale lease metadata on a non-running run', async () => {
    for (const status of ['queued', 'completed', 'failed']) {
      const r = await rig(target);
      try {
        const attemptId = await r.claim(r.owner.token);
        const next = await r.rotate(r.owner.token, r.owner.tokenId);
        r.e.sqlite.run('UPDATE agent_runs SET status=? WHERE id=?', [status, RUN.runId]);
        expect((await r.post(next.token, '/worker/lease', { ...RUN, attemptId })).body).toMatchObject({ held: false });
        expect(r.row()).toMatchObject({ leasedBy: r.owner.tokenId, attemptId, status });
      } finally { r.close(); }
    }
  });

  it('rolls lease ownership and activation back together if the activation batch fails', async () => {
    const r = await rig(target);
    try {
      const attemptId = await r.claim(r.owner.token);
      const next = await r.rotate(r.owner.token, r.owner.tokenId);
      const batch = r.env.db.batch.bind(r.env.db);
      r.env.db.batch = (statements) => batch([...statements, r.env.db.prepare(
        `INSERT INTO members (id,label,created_at) VALUES ('mem_worker','duplicate',0)`,
      )]);
      try {
        expect(await r.post(next.token, '/worker/lease', { ...RUN, attemptId })).toMatchObject({ status: 503 });
        expect(r.row()).toMatchObject({ leasedBy: r.owner.tokenId, attemptId });
        expect(r.e.sqlite.query('SELECT first_used_at, revoked_at FROM member_credentials WHERE id=?').get(next.tokenId))
          .toEqual({ first_used_at: null, revoked_at: null });
        expect(r.e.sqlite.query('SELECT revoked_at FROM member_credentials WHERE id=?').get(r.owner.tokenId))
          .toEqual({ revoked_at: null });
      } finally { r.env.db.batch = batch; }
      expect((await r.post(next.token, '/worker/lease', { ...RUN, attemptId })).body).toMatchObject({ held: true });
    } finally { r.close(); }
  });

  it('rejects malformed repository attempt identities through the shared accounting parser', async () => {
    const r = await rig(target);
    try {
      await r.claim(r.owner.token);
      for (const attemptId of ['', 42, 'not an id!']) {
        expect((await r.post(r.owner.token, '/worker/repository', { ...RUN, attemptId })).body)
          .toMatchObject({ persisted: false, code: 'parse' });
      }
    } finally { r.close(); }
  });
});
