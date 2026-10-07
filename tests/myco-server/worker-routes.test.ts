import { offeredHarness } from './helpers/offered-harness.js';
/**
 * Who reaches the worker control plane, and what it answers.
 *
 * Three properties the route table alone cannot state: a claim names no
 * Project and is answered anyway, a member who does not administer the
 * Deployment is refused before anything is minted, and a run's own credential
 * reaches none of these routes.
 */
import { jsonBody } from '../helpers/json-body.js';
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { memberHeaders, sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import { MODEL_CATALOG_FRESH_MS } from '@goondocks/myco-shared/execution-profile';
import { expireLeases } from '@myco-server-worker/core/harness.js';

const NOW = 1_800_000_000_000;

function post(token: string, path: string, body: unknown, extra: Record<string, string> = {}): Request {
  return new Request(`https://s${path}`, { method: 'POST', headers: memberHeaders(token, extra), body: JSON.stringify(body) });
}

async function rig() {
  const e = sqliteEnv({ workerLogin: true });
  turnOnGatedCapabilities(e.sqlite);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  const member = async (id: string, role: 'admin' | 'member') => {
    await ensureMember(e.db, id, NOW, role, id);
    return (await issueMemberToken(e.db, { memberId: id, machineId: id }, NOW)).token;
  };
  await ensureMember(e.db, HARNESS_MEMBER_ID, NOW, 'member', 'harness runtime');
  const harness = (await issueMemberToken(e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, NOW)).token;
  const anonymous = (await issueMemberToken(e.db, { memberId: 'mem_anon', machineId: null }, NOW)).token;
  const json = async (req: Request) => {
    const res = await worker.fetch(req, e.env);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  return { e, member, harness, anonymous, json };
}

const PATHS = ['/worker/claim', '/worker/lease', '/worker/end', '/worker/repository', '/worker/models'] as const;

describe('the worker control plane', () => {
  it('answers an administrator a claim that names no Project', async () => {
    const r = await rig();
    const admin = await r.member('mem_admin', 'admin');
    const answered = await r.json(post(admin, '/worker/claim', { harnesses: [] }));
    // No Project header, and the request is answered rather than refused: a
    // worker claims across every Project the Deployment holds.
    expect(answered).toEqual({ status: 200, body: { persisted: true, claimed: false, reason: 'no_work', pollAfterMs: expect.any(Number) } });
  });

  it('refuses every route to a member who does not administer the Deployment, minting nothing', async () => {
    const r = await rig();
    const plain = await r.member('mem_plain', 'member');
    const before = (r.e.sqlite.query(`SELECT COUNT(*) AS n FROM member_credentials`).get() as { n: number }).n;
    for (const path of PATHS) {
      const answered = await r.json(post(plain, path, {}));
      expect({ path, ...answered }).toEqual({ path, status: 200, body: { persisted: false, code: 'not_admin', reason: expect.any(String) } });
    }
    expect(r.e.sqlite.query(`SELECT COUNT(*) AS n FROM member_credentials`).get()).toEqual({ n: before });
  });

  it('refuses every route to a run\'s own credential: a run drives no worker', async () => {
    const r = await rig();
    for (const path of PATHS) {
      const answered = await r.json(post(r.harness, path, {}));
      expect({ path, ...answered }).toEqual({ path, status: 200, body: { persisted: false, code: 'run_scope', reason: expect.any(String) } });
    }
  });

  it('refuses every route to a credential with no machine identity', async () => {
    const r = await rig();
    for (const path of PATHS) {
      const answered = await r.json(post(r.anonymous, path, {}));
      expect({ path, code: answered.body.code }).toEqual({ path, code: 'no_machine_identity' });
    }
  });

  it('refuses a body it cannot read, and answers a lease and an end it can', async () => {
    const r = await rig();
    const admin = await r.member('mem_admin', 'admin');
    const unreadable = await worker.fetch(new Request('https://s/worker/lease', { method: 'POST', headers: memberHeaders(admin), body: 'not json' }), r.e.env);
    expect(await jsonBody(unreadable)).toEqual({ persisted: false, code: 'parse', reason: expect.any(String) });

    expect(await r.json(post(admin, '/worker/lease', { projectId: 'proj_1', runId: 'run_absent' })))
      .toEqual({ status: 200, body: { persisted: true, held: false, reason: expect.any(String) } });
    expect(await r.json(post(admin, '/worker/end', { projectId: 'proj_1', runId: 'run_absent', status: 'failed' })))
      .toEqual({ status: 200, body: { persisted: true, ended: false, reason: expect.any(String) } });
    // An end that names no outcome is answered rather than guessed at.
    expect((await r.json(post(admin, '/worker/end', { projectId: 'proj_1', runId: 'run_absent' }))).body)
      .toEqual({ persisted: true, ended: false, reason: expect.any(String) });
  });

  it('names its own cadence on every answer, so a worker keeps none of its own', async () => {
    const r = await rig();
    const admin = await r.member('mem_admin', 'admin');
    const idle = await r.json(post(admin, '/worker/claim', { harnesses: [] }));
    expect(idle.body.pollAfterMs).toEqual(expect.any(Number));

    // A claimed answer carries how often to renew; an idle one carries how long
    // to wait. Both are the Deployment's to change.
    r.e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
    r.e.sqlite.run(
      `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
       VALUES ('proj_1', 'run_c', 'myco-agent', 'extract-curate', 'queued', ?, 'worker', ?, ?, 'do it')`,
      [NOW, JSON.stringify({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300 })],
    );
    const claimed = await r.json(post(admin, '/worker/claim', { harnesses: [offeredHarness('claude-code')] }));
    expect(claimed.body.claimed).toBe(true);
    expect(claimed.body.heartbeatMs).toEqual(expect.any(Number));
  });

  it('ignores a Project header a worker sends: the Project is the run\'s, never the caller\'s', async () => {
    const r = await rig();
    const admin = await r.member('mem_admin', 'admin');
    const answered = await r.json(post(admin, '/worker/claim', { harnesses: [] }, { [PROJECT_HEADER]: 'proj_elsewhere' }));
    expect(answered.status).toBe(200);
    expect(answered.body.persisted).toBe(true);
  });
});

describe('the models a machine lists', () => {
  const listed = (harness: string, models: unknown[], fetchedAt = Date.now() - 1_000) => ({ catalog: { harness, source: { kind: 'exchange', command: 'codex app-server' }, signIn: 'worker-login', fetchedAt, models } });
  const stored = (r: Awaited<ReturnType<typeof rig>>) => r.e.sqlite.query(`SELECT machine_id, harness, catalog, resolutions FROM worker_model_catalogs ORDER BY machine_id, harness`).all() as Array<{ machine_id: string; harness: string; catalog: string; resolutions: string }>;
  const settings = async (r: Awaited<ReturnType<typeof rig>>, sub?: string) => {
    const res = await worker.fetch(new Request('https://s/api/settings', { headers: { cookie: await ownerCookie(r.e.db, Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' } }), { ...r.e.env, ...OWNER_ENV });
    return await res.json() as { models?: Array<Record<string, unknown> & { harness: string; models: Array<Record<string, unknown> & { id: string }> }> };
  };
  const offered = async (r: Awaited<ReturnType<typeof rig>>) => (await settings(r)).models?.flatMap((catalog) => catalog.models.map((model) => `${catalog.harness}:${model.id}`)).sort();

  it('keeps one list per machine and agent, holding only models the agent\'s settings accept, each once, with the resolutions it lists', async () => {
    const r = await rig();
    const admin = await r.member('mem_admin', 'admin');
    const first = await r.json(post(admin, '/worker/models', listed('claude-code', [
      { id: 'opus', label: 'Opus 5.5', resolvesTo: 'claude-opus-5-5' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1', resolvesTo: 'claude-fable-5-1' },
      { id: 'opus', label: 'a repeat' },
      { id: 'default', label: 'refused by the pattern' },
    ])));
    expect(first).toEqual({ status: 200, body: { persisted: true, recorded: true, models: 2 } });
    expect(stored(r).map((row) => ({ machine: row.machine_id, harness: row.harness, models: JSON.parse(row.catalog).models.map((m: { id: string }) => m.id), resolutions: JSON.parse(row.resolutions) })))
      .toEqual([{ machine: 'mem_admin', harness: 'claude-code', models: ['opus', 'claude-fable-5-1'], resolutions: { opus: 'claude-opus-5-5' } }]);
  });

  it('replaces a machine\'s list whichever of its credentials reports it, so a credential that rotated leaves nothing behind', async () => {
    const r = await rig();
    const before = await r.member('mem_admin', 'admin');
    await r.json(post(before, '/worker/models', listed('codex', [{ id: 'gpt-5.5', label: 'GPT-5.5' }, { id: 'gpt-6-sol', label: 'GPT-6-Sol' }])));
    const after = (await issueMemberToken(r.e.db, { memberId: 'mem_admin', machineId: 'mem_admin' }, NOW)).token;
    await r.json(post(after, '/worker/models', listed('codex', [{ id: 'gpt-6-sol', label: 'GPT-6-Sol' }])));
    expect(stored(r).map((row) => row.machine_id)).toEqual(['mem_admin']);
    // A model the machine stopped listing is offered no more.
    expect(await offered(r)).toEqual(['codex:gpt-6-sol']);
  });

  it('offers only lists received within the freshness window, and the lease sweep forgets a machine that stopped listing', async () => {
    const r = await rig();
    const kept = await r.member('mem_kept', 'admin');
    const gone = await r.member('mem_gone', 'admin');
    await r.json(post(kept, '/worker/models', listed('codex', [{ id: 'gpt-6-sol', label: 'GPT-6-Sol' }])));
    await r.json(post(gone, '/worker/models', listed('codex', [{ id: 'gpt-5.5', label: 'GPT-5.5' }])));
    const now = Date.now();
    r.e.sqlite.run(`UPDATE worker_model_catalogs SET received_at = ? WHERE machine_id = 'mem_gone'`, [now - MODEL_CATALOG_FRESH_MS - 1]);
    r.e.sqlite.run(`UPDATE worker_model_catalogs SET received_at = ? WHERE machine_id = 'mem_kept'`, [now - MODEL_CATALOG_FRESH_MS + 60_000]);
    expect(await offered(r)).toEqual(['codex:gpt-6-sol']);
    await expireLeases(r.e.serverEnv, now);
    expect(stored(r).map((row) => row.machine_id)).toEqual(['mem_kept']);
  });

  it('answers the lists to an admin only: they say which providers each machine is signed in to', async () => {
    const r = await rig();
    seedMemberRoleAccount(r.e.sqlite);
    const admin = await r.member('mem_admin', 'admin');
    await r.json(post(admin, '/worker/models', listed('opencode', [{ id: 'openrouter/~anthropic/claude-opus-latest', label: 'openrouter/~anthropic/claude-opus-latest', provider: 'openrouter' }])));
    expect((await settings(r)).models).toEqual([{
      harness: 'opencode', source: { kind: 'exchange', command: 'codex app-server' }, signIn: 'worker-login', fetchedAt: expect.any(Number), receivedAt: expect.any(Number),
      models: [{ id: 'openrouter/~anthropic/claude-opus-latest', label: 'openrouter/~anthropic/claude-opus-latest', provider: 'openrouter' }],
    }]);
    const member = await settings(r, MEMBER_SUB);
    expect({ answered: 'models' in member, mentions: JSON.stringify(member).includes('claude-opus-latest') }).toEqual({ answered: false, mentions: false });
  });

  it('answers a list it cannot keep in its own shape, keeping nothing', async () => {
    const r = await rig();
    const admin = await r.member('mem_admin', 'admin');
    const unsigned = listed('codex', []);
    delete (unsigned.catalog as { signIn?: string }).signIn;
    for (const body of [listed('cursor', [{ id: 'gpt-6' }]), listed('no-such-agent', []), unsigned, { catalog: { harness: 'codex', source: { kind: 'exchange', command: 'codex' }, signIn: 'worker-login', models: [] } }, {}]) {
      expect((await r.json(post(admin, '/worker/models', body))).body).toEqual({ persisted: true, recorded: false, reason: expect.any(String) });
    }
    expect(stored(r)).toEqual([]);
  });
});
