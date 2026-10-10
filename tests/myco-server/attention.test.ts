/**
 * Needs you (`/api/attention`): what an administrator should act on.
 *
 * Only an administrator reads it. Every rule reads the state a problem is in, so a failure something later recovered
 * from is never an item: the search index counts only when it is actually behind, a failed outcome only while no later
 * run of its task completed, and a learning run that failed having saved spores is not a failed outcome.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { seedCredential } from './helpers/d1.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { readAttention, SEARCH_BEHIND_MS, CAPABILITY_HOLD_MS, ACCESS_KEY_NOTICE_MS } from '@myco-server-worker/core/attention.js';
import { PARSER_VERSION } from '@myco-server-worker/ingest/parse.js';
import { CAPABILITY_HOLDS } from '@goondocks/myco-shared/run-holds';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const { sqlite } = fixture;
  sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, ?)`, [NOW]);
  const run = (project: string, id: string, task: string, status: string, at: number, over: { heldBy?: string; queuedAt?: number } = {}) =>
    sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, queued_at, held_by, error)
                VALUES (?, ?, 'agent_1', ?, ?, ?, ?, ?, ?, ?)`,
    [project, id, task, status, status === 'queued' ? null : at, status === 'queued' || status === 'running' ? null : at + 1000,
      over.queuedAt ?? (status === 'queued' ? at : null), over.heldBy ?? null, status === 'failed' ? 'the run ended without its artifact' : null]);
  const spore = (project: string, id: string, author: string) => {
    sqlite.run(`INSERT OR IGNORE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES (?, 's1', 'm1', 'tok_1', ?, ?)`, [project, NOW, NOW]);
    sqlite.run(`INSERT INTO spores (project_id, id, agent_id, session_id, observation_type, status, content, author, created_at) VALUES (?, ?, 'agent_1', 's1', 'gotcha', 'active', 'x', ?, ?)`, [project, id, author, NOW]);
  };
  const read = (now = NOW, over: Record<string, unknown> = {}) => readAttention({ ...fixture.serverEnv, ...over } as never, now);
  const kinds = async (now = NOW, over: Record<string, unknown> = {}) => (await read(now, over)).items.map((i) => i.kind);
  return { fixture, env, sqlite, run, spore, read, kinds };
}

describe('Needs you', () => {
  it('answers an administrator and refuses a member who is not one', async () => {
    const { env, sqlite, fixture } = harness();
    seedMemberRoleAccount(sqlite);
    const get = async (sub?: string) => {
      const res = await worker.fetch(new Request('https://s/api/attention', { headers: { cookie: await ownerCookie(fixture.db, Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' } }), env);
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    expect(await get()).toEqual({ status: 200, body: { items: [], unavailable: [] } });
    expect(await get(MEMBER_SUB)).toMatchObject({ status: 403, body: { error: 'not_admin' } });
  });

  it('counts the search index only when text has actually waited on it, or its updates keep failing with no success after', async () => {
    const { sqlite, run, read, kinds } = harness();
    const pending = (key: string, storedAt: number, complete = 0) => {
      sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation) VALUES ('proj_1', ?, 1, 'text/plain', 't', ?, ?)`, [key, storedAt, crypto.randomUUID()]);
      sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, content_hash, status, blob_key, created_at, updated_at, token_id, received_at)
                  VALUES ('proj_1', ?, 's', ?, 'm1', 'h', 'active', ?, 1, 1, 't', 1)`, [crypto.randomUUID(), `ev_${key}`, key]);
      // A plan naming a blob enqueues it for the index; the queue row is then set to the state under test.
      sqlite.run(`INSERT INTO search_blob_queue (project_id, blob_key, complete) VALUES ('proj_1', ?, ?)
                  ON CONFLICT (project_id, blob_key) DO UPDATE SET complete = excluded.complete`, [key, complete]);
    };
    // Text stored a moment ago is being indexed, not behind.
    pending('a'.repeat(64), NOW - 5 * MINUTE);
    pending('b'.repeat(64), NOW - 5 * HOUR, 1);
    expect(await kinds()).toEqual([]);
    // Failed updates a later success answered are retries.
    run('proj_1', 'run_e1', 'embedding-reconcile', 'failed', NOW - 3 * HOUR);
    run('proj_1', 'run_e2', 'embedding-reconcile', 'failed', NOW - 2 * HOUR);
    run('proj_1', 'run_e3', 'embedding-reconcile', 'completed', NOW - HOUR);
    expect(await kinds()).toEqual([]);
    // Text that has waited past the bound is behind.
    expect(await kinds(NOW - 5 * MINUTE + SEARCH_BEHIND_MS + 1)).toEqual(['search_index_behind']);
    expect((await read(NOW + SEARCH_BEHIND_MS)).items).toEqual([{
      kind: 'search_index_behind', tone: 'warn', pendingBlobs: 1, pendingSince: NOW - 5 * MINUTE, failedUpdates: 0, failingSince: null, lastSuccessAt: NOW - HOUR,
    }]);
    // Updates failing after the last success, for longer than the bound, are behind whatever the text queue says.
    sqlite.run(`UPDATE search_blob_queue SET complete = 1`);
    run('proj_2', 'run_e4', 'embedding-reconcile', 'failed', NOW - 50 * MINUTE);
    expect((await read()).items).toEqual([{
      kind: 'search_index_behind', tone: 'warn', pendingBlobs: 0, pendingSince: null, failedUpdates: 1, failingSince: NOW - 50 * MINUTE, lastSuccessAt: NOW - HOUR,
    }]);
    run('proj_2', 'run_e5', 'embedding-reconcile', 'completed', NOW - 40 * MINUTE);
    expect(await kinds()).toEqual([]);
  });

  it('names a learning or map outcome that failed until a later run of its task completes, and never a failure that saved its spores', async () => {
    const { run, spore, read, kinds } = harness();
    run('proj_1', 'run_l1', 'extract-curate', 'failed', NOW - 2 * HOUR);
    spore('proj_1', 'sp1', 'run_l1');
    expect(await kinds()).toEqual([]);
    run('proj_1', 'run_l2', 'extract-curate', 'failed', NOW - HOUR);
    run('proj_2', 'run_m1', 'canopy-map', 'failed', NOW - 3 * HOUR);
    run('proj_2', 'run_m2', 'canopy-map', 'failed', NOW - 2 * HOUR);
    const { items } = await read();
    expect(items).toEqual([
      { kind: 'outcome_failed', tone: 'bad', projectId: 'proj_1', outcome: 'learn', task: 'extract-curate', failures: 1, since: NOW - HOUR, latestAt: NOW - HOUR, runId: 'run_l2' },
      { kind: 'outcome_failed', tone: 'bad', projectId: 'proj_2', outcome: 'map', task: 'canopy-map', failures: 2, since: NOW - 3 * HOUR, latestAt: NOW - 2 * HOUR, runId: 'run_m2' },
    ]);
    run('proj_1', 'run_l3', 'extract-curate', 'completed', NOW - 30 * MINUTE);
    expect((await read()).items.map((i) => ('projectId' in i ? i.projectId : null))).toEqual(['proj_2']);
    // A failure older than the lookback is no longer news.
    expect(await kinds(NOW + 8 * DAY)).toEqual([]);
  });

  it('names transcripts the current parser stopped, and not ones waiting for bytes or stopped by an older parser', async () => {
    const { sqlite, read } = harness();
    const transcript = (id: string, error: string, version: number) =>
      sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, first_received_at, last_received_at, token_id, parsed_offset, parse_error, parse_failed_at, parser_version)
                  VALUES ('proj_1', ?, 's1', 'm1', 100, 1, 1, 't', 10, ?, ?, ?)`, [id, error, NOW - HOUR, version]);
    transcript('tx_parse', 'parse', PARSER_VERSION);
    transcript('tx_refused', 'event_refused', PARSER_VERSION);
    transcript('tx_wait', 'awaiting_bytes', PARSER_VERSION);
    transcript('tx_old', 'parse', PARSER_VERSION - 1);
    expect((await read()).items).toEqual([{ kind: 'transcripts_stopped', tone: 'warn', projectId: 'proj_1', transcripts: 2, latestAt: NOW - HOUR, reasons: { parse: 1, event_refused: 1 } }]);
  });

  it('only exposes bounded stop diagnostics from the latest failure', async () => {
    const { sqlite, read } = harness();
    sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size,
      first_received_at, last_received_at, token_id, parsed_offset, parse_error, parse_failed_at, parser_version, parser_context)
      VALUES ('proj_1','tx_diagnostic','s1','m1',100,1,1,'t',10,'parse',?,?,?)`,
    [NOW, PARSER_VERSION, JSON.stringify({ mycoParserFailure: { branch: 'no_progress', offset: 10, lineKind: 'private arbitrary value' } })]);
    const item = (await read()).items.find((item) => item.kind === 'transcripts_stopped');
    expect(item).toMatchObject({ latestDiagnostic: { branch: 'no_progress', offset: 10, lineKind: 'unknown' } });
    sqlite.run('UPDATE transcripts SET parser_context=?', [JSON.stringify({ mycoParserFailure: { branch: 'private arbitrary value', offset: 10, lineKind: 'user' } })]);
    expect((await read()).items.find((item) => item.kind === 'transcripts_stopped')).not.toHaveProperty('latestDiagnostic');
    sqlite.close();
  });

  it('names runs held past the bound for a capability no worker reports', async () => {
    const { run, read } = harness();
    const capability = CAPABILITY_HOLDS[0]!;
    run('proj_1', 'run_q1', 'canopy-map', 'queued', NOW - 5 * MINUTE, { heldBy: capability });
    const held = await read();
    expect(held.items.filter((i) => i.kind === 'runs_held_for_capability')).toEqual([]);
    run('proj_2', 'run_q2', 'canopy-map', 'queued', NOW - CAPABILITY_HOLD_MS - 1, { heldBy: capability });
    expect((await read()).items.filter((i) => i.kind === 'runs_held_for_capability'))
      .toEqual([{ kind: 'runs_held_for_capability', tone: 'warn', capability, runs: 1, since: NOW - CAPABILITY_HOLD_MS - 1 }]);
  });

  it('names queued runs no worker is there to take, until a worker reports in', async () => {
    const { sqlite, run, read, kinds } = harness();
    run('proj_1', 'run_q', 'extract-curate', 'queued', NOW - 10 * MINUTE, { heldBy: 'worker' });
    run('proj_1', 'run_emb', 'embedding-reconcile', 'queued', NOW - 20 * MINUTE, { heldBy: 'runtime' });
    expect((await read()).items).toEqual([{ kind: 'no_worker', tone: 'bad', runs: 1, since: NOW - 10 * MINUTE, lastContactAt: null }]);
    seedCredential(sqlite, { id: 'mt_worker', machineId: 'machine_1' });
    sqlite.run(`INSERT INTO worker_contacts (credential_id, machine_id, last_seen_at, updated_at) VALUES ('mt_worker', 'machine_1', ?, ?)`, [NOW - 30 * 1000, NOW]);
    expect(await kinds()).toEqual([]);
  });

  it('leaves out a queued run a runtime already holds: only runs a worker would take wait for one', async () => {
    const { sqlite, run, kinds } = harness();
    seedCredential(sqlite, { id: 'mt_dispatch', machineId: 'machine_1' });
    run('proj_1', 'run_held', 'extract-curate', 'queued', NOW - 10 * MINUTE, { heldBy: 'worker' });
    sqlite.run(`UPDATE agent_runs SET dispatched_by = 'mt_dispatch' WHERE id = 'run_held'`);
    expect(await kinds()).toEqual([]);
  });

  it('leaves out a Project that no longer accepts capture from every rule that reads its runs or transcripts', async () => {
    const { sqlite, run, read } = harness();
    run('proj_2', 'run_failed', 'extract-curate', 'failed', NOW - HOUR);
    run('proj_2', 'run_waiting', 'extract-curate', 'queued', NOW - 10 * MINUTE, { heldBy: 'worker' });
    run('proj_2', 'run_held', 'canopy-map', 'queued', NOW - CAPABILITY_HOLD_MS - 1, { heldBy: CAPABILITY_HOLDS[0]! });
    sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, first_received_at, last_received_at, token_id, parsed_offset, parse_error, parse_failed_at, parser_version)
                VALUES ('proj_2', 'tx_1', 's1', 'm1', 100, 1, 1, 't', 10, 'parse', ?, ?)`, [NOW - HOUR, PARSER_VERSION]);
    expect((await read()).items.map((i) => i.kind).sort()).toEqual(['no_worker', 'outcome_failed', 'runs_held_for_capability', 'transcripts_stopped']);
    sqlite.run(`UPDATE projects SET archived_at = ?, archived_by = 'mem_machine_1' WHERE project_id = 'proj_2'`, [NOW]);
    expect(await read()).toEqual({ items: [], unavailable: [] });
  });

  it('names a live access key that expires within the notice, and no other', async () => {
    const { sqlite, read } = harness();
    const grant = (id: string, expiresAt: number, revokedAt: number | null = null) =>
      sqlite.run(`INSERT INTO external_grants (id, project_id, key_hash, label, created_by, created_at, expires_at, revoked_at) VALUES (?, 'proj_1', ?, 'ci', 'mem_machine_1', 1, ?, ?)`,
        [id, `h_${id}`, expiresAt, revokedAt]);
    grant('eg_soon', NOW + 3 * DAY);
    grant('eg_later', NOW + ACCESS_KEY_NOTICE_MS + DAY);
    grant('eg_revoked', NOW + DAY, NOW - DAY);
    grant('eg_gone', NOW - DAY);
    expect((await read()).items).toEqual([{ kind: 'access_key_expiring', tone: 'warn', grantId: 'eg_soon', projectId: 'proj_1', label: 'ci', expiresAt: NOW + 3 * DAY }]);
  });

  it('names a schema that is not the one this server expects', async () => {
    const { sqlite, read } = harness();
    sqlite.run(`UPDATE schema_meta SET value = '12' WHERE key = 'version'`);
    expect((await read()).items).toEqual([expect.objectContaining({ kind: 'schema_mismatch', tone: 'bad', found: 12 })]);
  });

  it('names a backup older than twice its interval, or none while backups are configured, and says when the producer cannot be read', async () => {
    const { sqlite, read, kinds } = harness();
    const producer = (stage: string, startedAt: number | null) => ({ recovery: { status: async () => ({ attempt: 1, stage, startedAt }) } });
    // Not configured: nothing is owed.
    expect(await kinds(NOW, producer('idle', null))).toEqual([]);
    sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('backup.auto_interval_hours', '24', 1, 'mem_machine_1')`);
    expect((await read(NOW, producer('idle', null))).items).toEqual([{ kind: 'backup_overdue', tone: 'warn', lastBackupAt: null, intervalHours: 24 }]);
    expect(await kinds(NOW, producer('complete', NOW - 30 * HOUR))).toEqual([]);
    expect((await read(NOW, producer('complete', NOW - 49 * HOUR))).items).toEqual([{ kind: 'backup_overdue', tone: 'warn', lastBackupAt: NOW - 49 * HOUR, intervalHours: 24 }]);
    sqlite.run(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer) VALUES ('bk_1', 'backups/bk_1', ?, 1, '{}', 57, 'mem_machine_1')`, [NOW - 10 * HOUR]);
    expect(await kinds(NOW, producer('failed', NOW - HOUR))).toEqual([]);
    const unreadable = await read(NOW, { recovery: { status: async () => { throw new Error('paused'); } } });
    expect(unreadable).toEqual({ items: [], unavailable: ['backup_overdue'] });
  });
});
