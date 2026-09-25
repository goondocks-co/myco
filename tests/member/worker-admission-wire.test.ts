/**
 * The worker admission probe against the real server pipeline.
 *
 * `myco worker install` asks the Deployment whether it admits this home's
 * credential as a worker, by renewing a lease that names no run. The claim is
 * too costly to use for the question — it takes a run — so the probe is only
 * safe while the lease route answers it by the same administrator gate and
 * writes nothing. Both are held here against `createServer(...).handleRequest`
 * over the SQLite fixture, with a run leased to another worker in the table.
 */
import { describe, expect, it } from 'bun:test';
import { probeWorkerAdmission } from '@myco/runner/loop.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.ts';

const NOW = 1_800_000_000_000;

describe('asking the Deployment whether it admits a worker', () => {
  it('answers admitted, not_admin and unauthorized for the three credentials, and changes nothing', async () => {
    const e = sqliteEnv();
    const server = createServer({ now: () => Date.now(), sourceOf: () => '1.2.3.4', fetchImpl: (input, init) => fetch(input, init) });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
      server.handleRequest(new Request(typeof input === 'string' || input instanceof URL ? String(input) : input.url, init), e.serverEnv)) as unknown as typeof fetch;
    const member = async (id: string, role: 'admin' | 'member') => {
      await ensureMember(e.db, id, NOW, role, id);
      return (await issueMemberToken(e.db, { memberId: id, machineId: id }, NOW)).token;
    };
    const admin = await member('mem_admin', 'admin');
    const plain = await member('mem_plain', 'member');
    const unknown = 'x'.repeat(43);
    await ensureMember(e.db, 'mem_other', NOW, 'admin', 'mem_other');
    const other = (await issueMemberToken(e.db, { memberId: 'mem_other', machineId: 'mem_other' }, NOW)).tokenId;

    e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
    e.sqlite.run(
      `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, started_at, dispatched_by, leased_by, lease_expires_at, harness, dispatch_spec, run_context, instruction)
       VALUES ('proj_1', 'run_held', 'myco-agent', 'extract-curate', 'running', ?, ?, ?, ?, ?, 'codex', ?, ?, 'do it')`,
      [Date.now(), Date.now(), other, other, Date.now() + 600_000, JSON.stringify({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300 })],
    );

    /** Every row of every table, so a write anywhere is seen, not only where one is expected. */
    const snapshot = (): Record<string, unknown[]> => {
      const tables = (e.sqlite.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>).map((t) => t.name);
      return Object.fromEntries(tables.map((name) => [name, e.sqlite.query(`SELECT * FROM "${name}"`).all()]));
    };
    const before = snapshot();
    // The tables the question could plausibly touch are asserted to hold rows, so an empty snapshot cannot pass for an unchanged one.
    for (const table of ['agent_runs', 'member_credentials']) expect({ table, rows: (before[table] ?? []).length > 0 }).toEqual({ table, rows: true });
    expect(before).toHaveProperty('worker_contacts');

    const ask = (token: string) => probeWorkerAdmission({ serverUrl: 'https://deployment.example', token, fetchImpl, signal: AbortSignal.timeout(5_000) });
    expect(await ask(admin)).toBe('admitted');
    expect(await ask(plain)).toBe('not_admin');
    expect(await ask(unknown)).toBe('unauthorized');

    expect(snapshot()).toEqual(before);
    expect(e.sqlite.query(`SELECT status, leased_by FROM agent_runs WHERE id = 'run_held'`).get()).toEqual({ status: 'running', leased_by: other });
  });
});
