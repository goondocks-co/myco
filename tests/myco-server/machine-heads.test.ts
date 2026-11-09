/**
 * Stable machine and runner facts: a machine's revision and contact survive credential rotation and catch-up, harness
 * reports keep their trust state under concurrency, the active fleet pages without tombstones, and a legacy contact is
 * stored in an export before its row goes.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { issueMemberToken } from './helpers/member-token.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { activateRunnerSuccessor, type RunnerAuth } from '@myco-server-worker/auth/runners.js';
import { CONTACT_THROTTLE_MS, HARNESS_MEMBER_ID } from '@myco-server-worker/constants.js';
import { recordProvisionedHarnessReport, HarnessReportContended } from '@myco-server-worker/core/harness-health.js';
import { pruneWorkerContacts, readRemovedRunners, readWorkerFleet, recordWorkerContact, WORKER_CONTACT_RETENTION_MS } from '@myco-server-worker/core/worker-contacts.js';
import { catchUpProjections, projectionReadiness, resetProjectionCatchup } from '@myco-server-worker/db/projections/catchup.js';
import { commitHarnessReport, machineHarnessState } from '@myco-server-worker/db/runners/harness-health.js';
import { hasQueuedRun, unclaimedQueued } from '@myco-server-worker/db/runs/queue.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { NEXT_S1C } from '@myco-server-worker/db/schema-vNEXT-s1c.js';
import { listMachines } from '@myco-server-worker/read/machines.js';
import { pruneTerminalRuns } from '@myco-server-worker/db/runs/retention.js';
import { fleetTotals, pageRunners, parseFleetPage } from '@myco-server-worker/core/fleet-page.js';
import type { RunnerFleetRecord } from '@goondocks/myco-shared/runner-fleet';
import { sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const OFFER = [{ id: 'codex', authenticated: true }];
const OTHER = [{ id: 'claude-code', authenticated: true }];

async function rig() {
  const e = sqliteEnv({ workerLogin: true });
  await ensureMember(e.db, HARNESS_MEMBER_ID, NOW, 'member', 'harness runtime');
  const admin = async (id: string, machineId: string) => {
    await ensureMember(e.db, id, NOW, 'admin', id);
    return issueMemberToken(e.db, { memberId: id, machineId }, NOW);
  };
  const head = (machine: string) => e.sqlite.query('SELECT * FROM machine_head WHERE machine_id = ?').get(machine) as Record<string, unknown> | null;
  const drain = async () => {
    const outcome = await catchUpProjections(e.db, { budget: { calls: 2_000, wallMs: 60_000 } });
    expect(outcome.more).toBe(false);
  };
  return { e, admin, head, drain };
}

describe('the stable machine head', () => {
  it('keeps one rising revision across a credential rotation, and each credential keeps its own report', async () => {
    const r = await rig();
    const first = await r.admin('mem_a', 'studio');
    const rotated = await r.admin('mem_a', 'studio');
    await recordWorkerContact(r.e.db, { credentialId: first.tokenId, machineId: 'studio', offers: OFFER, capabilities: [], now: NOW });
    const before = r.head('studio')!;
    // The successor reports inside the same millisecond, so wall time alone could not order the two reports.
    await recordWorkerContact(r.e.db, { credentialId: rotated.tokenId, machineId: 'studio', offers: OTHER, capabilities: [], now: NOW });
    const after = r.head('studio')!;
    expect(after.revision as number).toBeGreaterThan(before.revision as number);
    expect(JSON.parse(String(after.offers))).toEqual(OTHER);
    expect(after).toMatchObject({ offers_credential_id: rotated.tokenId, latest_contact_credential_id: rotated.tokenId, latest_contact_at: NOW });
    expect(r.e.sqlite.query('SELECT credential_id, offers FROM worker_contacts ORDER BY updated_at').all()).toEqual([
      { credential_id: first.tokenId, offers: JSON.stringify(OFFER) }, { credential_id: rotated.tokenId, offers: JSON.stringify(OTHER) },
    ]);
  });

  it('skips an unchanged poll inside the throttle and lets a changed machine through', async () => {
    const r = await rig();
    const worker = await r.admin('mem_a', 'studio');
    const successor = await r.admin('mem_a', 'studio');
    const report = (credentialId: string, offers: typeof OFFER, now: number) => recordWorkerContact(r.e.db, { credentialId, machineId: 'studio', offers, capabilities: [], reason: 'no_work', now });
    expect(await report(worker.tokenId, OFFER, NOW)).toBe(true);
    expect(await report(worker.tokenId, OFFER, NOW + 1)).toBe(false);
    expect(await report(successor.tokenId, OTHER, NOW + 2)).toBe(true);
    // The same credential's report is unchanged, but the machine's latest offers now differ, so it must land.
    expect(await report(worker.tokenId, OFFER, NOW + 3)).toBe(true);
    expect(JSON.parse(String(r.head('studio')!.offers))).toEqual(OFFER);
  });

  it('moves liveness only once per throttle, and records a claim at once', async () => {
    const r = await rig();
    const worker = await r.admin('mem_a', 'studio');
    await recordWorkerContact(r.e.db, { credentialId: worker.tokenId, machineId: 'studio', offers: OFFER, capabilities: [], reason: 'no_work', now: NOW });
    r.e.sqlite.run('UPDATE worker_contacts SET last_seen_at = ? WHERE credential_id = ?', [NOW + 1, worker.tokenId]);
    expect(r.head('studio')!.latest_contact_at).toBe(NOW);
    r.e.sqlite.run('UPDATE worker_contacts SET last_seen_at = ? WHERE credential_id = ?', [NOW + CONTACT_THROTTLE_MS, worker.tokenId]);
    expect(r.head('studio')!.latest_contact_at).toBe(NOW + CONTACT_THROTTLE_MS);
    await recordWorkerContact(r.e.db, { credentialId: worker.tokenId, machineId: 'studio', reason: 'claimed', now: NOW + CONTACT_THROTTLE_MS + 5 });
    expect(r.head('studio')!.latest_run_at).toBe(NOW + CONTACT_THROTTLE_MS + 5);
  });

  it('answers building, never offline, while heads seed, and rebuilds the same facts under the catch-up fence', async () => {
    const r = await rig();
    const worker = await r.admin('mem_a', 'studio');
    r.e.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('studio', 'mem_a', ?)`, [NOW]);
    await recordWorkerContact(r.e.db, { credentialId: worker.tokenId, machineId: 'studio', offers: OFFER, capabilities: [], now: NOW });
    const revision = r.head('studio')!.revision as number;
    await resetProjectionCatchup(r.e.db);
    expect(r.head('studio')).toBeNull();
    expect(await projectionReadiness(r.e.db, 'machine_head')).toBe('building');
    const building = await listMachines(r.e.db, NOW, { all: true });
    expect(building).toMatchObject({ contactFacts: 'building', machines: [{ machineId: 'studio', lastContactAt: null, offers: null }] });
    // Every legacy contact stays listed while the head that normally selects them is absent.
    expect((await readWorkerFleet(r.e.db, NOW)).map(row => row.credentialId)).toEqual([worker.tokenId]);

    const successor = await r.admin('mem_a', 'studio');
    await recordWorkerContact(r.e.db, { credentialId: successor.tokenId, machineId: 'studio', offers: OTHER, capabilities: [], now: NOW });
    expect(r.head('studio')!.revision as number).toBeGreaterThan(revision);
    const allocated = r.head('studio')!.revision;

    await r.drain();
    expect(await projectionReadiness(r.e.db, 'machine_head')).toBe('ready');
    expect(r.head('studio')).toMatchObject({ revision: allocated, offers: JSON.stringify(OTHER), latest_contact_at: NOW });
    expect(await listMachines(r.e.db, NOW, { all: true })).toMatchObject({ contactFacts: 'ready', machines: [{ lastContactAt: NOW, offers: OTHER }] });
  });
});

describe('offers under catch-up', () => {
  const contact = (r: Awaited<ReturnType<typeof rig>>, credential: string, offers: string | null, at: number) => r.e.sqlite.run(
    `INSERT INTO worker_contacts(credential_id,machine_id,offers,capabilities,last_seen_at,updated_at) VALUES(?,'studio',?,'[]',?,?)`, [credential, offers, at, at]);

  it('keeps the latest report when a newer contact carrying none is reconciled first', async () => {
    const r = await rig();
    await ensureMember(r.e.db, 'mem_a', NOW, 'admin', 'mem_a');
    const credential = (id: string) => r.e.sqlite.run(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at) VALUES(?,'mem_a','studio',?,1,?,?,1)`, [id, id, NOW + 1_000_000, id]);
    // Reconciliation walks credential ids, so the successor with no report sorts ahead of the older report.
    credential('a_successor');
    credential('b_old');
    contact(r, 'b_old', JSON.stringify(OFFER), NOW);
    contact(r, 'a_successor', null, NOW + 5_000);
    await resetProjectionCatchup(r.e.db);
    await r.drain();
    expect(r.head('studio')).toMatchObject({ offers: JSON.stringify(OFFER), offers_revision: NOW, offers_credential_id: 'b_old', revision: NOW + 5_000 });
  });

  it('equals a recount of its contacts through rotation, renewals, claims, partial catch-up and reset', async () => {
    const random = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const mismatches: unknown[] = [];
    for (let seed = 1; seed <= 25; seed++) {
      const r = await rig();
      const next = random(seed * 7919);
      await ensureMember(r.e.db, 'mem_a', NOW, 'admin', 'mem_a');
      const credentials: string[] = [];
      const mint = async () => { const { tokenId } = await issueMemberToken(r.e.db, { memberId: 'mem_a', machineId: 'studio' }, NOW); credentials.push(tokenId); return tokenId; };
      await mint();
      let now = NOW;
      let peak = 0;
      for (let step = 0; step < 100; step++) {
        now += Math.floor(next() * 25_000);
        const credentialId = credentials[Math.floor(next() * credentials.length)]!;
        const op = next();
        if (op < 0.3) await recordWorkerContact(r.e.db, { credentialId, machineId: 'studio', offers: next() < 0.5 ? OFFER : OTHER, capabilities: [], reason: 'no_work', now });
        else if (op < 0.5) await recordWorkerContact(r.e.db, { credentialId, machineId: 'studio', now });
        else if (op < 0.6) await recordWorkerContact(r.e.db, { credentialId, machineId: 'studio', reason: 'claimed', now });
        else if (op < 0.75) { const fresh = await mint(); if (next() < 0.6) await recordWorkerContact(r.e.db, { credentialId: fresh, machineId: 'studio', now }); }
        else if (op < 0.9) await catchUpProjections(r.e.db, { budget: { calls: 2, wallMs: 5_000 } });
        else if (op < 0.94) { await resetProjectionCatchup(r.e.db); peak = 0; }
        const held = r.head('studio')?.revision as number | undefined;
        if (held !== undefined && held < peak) mismatches.push({ seed, step, kind: 'rewound' });
        peak = Math.max(peak, held ?? 0);
      }
      await r.drain();
      const rows = r.e.sqlite.query('SELECT offers, updated_at, last_seen_at, last_claim_at FROM worker_contacts').all() as Array<{ offers: string | null; updated_at: number; last_seen_at: number; last_claim_at: number | null }>;
      if (rows.length > 0) {
        const latest = Math.max(...rows.map(row => row.updated_at));
        const reported = rows.filter(row => row.offers !== null).sort((a, b) => b.updated_at - a.updated_at);
        const allowed = reported.filter(row => row.updated_at === reported[0]!.updated_at).map(row => row.offers);
        const head = r.head('studio')!;
        if (head.revision !== latest) mismatches.push({ seed, kind: 'revision', head: head.revision, latest });
        if (reported.length === 0 ? head.offers !== null : !allowed.includes(head.offers as string)) mismatches.push({ seed, kind: 'offers', head: head.offers, allowed });
        const lag = Math.max(...rows.map(row => row.last_seen_at)) - (head.latest_contact_at as number);
        if (lag < 0 || lag > CONTACT_THROTTLE_MS) mismatches.push({ seed, kind: 'contact', lag });
        const claims = rows.flatMap(row => row.last_claim_at === null ? [] : [row.last_claim_at]);
        if ((head.latest_run_at ?? null) !== (claims.length === 0 ? null : Math.max(...claims))) mismatches.push({ seed, kind: 'run', head: head.latest_run_at, claims });
      }
      r.e.sqlite.close();
    }
    expect(mismatches).toEqual([]);
  }, 120_000);
});

describe('runner heads and deleted runs', () => {
  async function fleetRig() {
    const r = await rig();
    r.e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
    r.e.sqlite.run(`INSERT INTO runners (id, name, created_at) VALUES ('rn_a', 'a', ?), ('rn_b', 'b', ?)`, [NOW, NOW]);
    for (const runner of ['rn_a', 'rn_b']) r.e.sqlite.run(`INSERT INTO runner_credentials (id, runner_id, token_hash, epoch, issued_at, expires_at, lineage_root) VALUES (?, ?, ?, 1, 1, ?, ?)`, [`rc_${runner}`, runner, `hash_${runner}`, NOW + 1_000_000, `rc_${runner}`]);
    const finish = (run: string, runner: string, status: 'completed' | 'failed', at: number) => {
      r.e.sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, issued_at, expires_at, lineage_root, lineage_started_at) VALUES (?, ?, ?, 1, ?, ?, 1)`, [`at_${run}`, HARNESS_MEMBER_ID, `hash_${run}`, NOW + 1_000_000, `at_${run}`]);
      r.e.sqlite.run(`INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at, started_at, leased_runner_id, leased_runner_credential_id, dispatched_by) VALUES (?, 'proj_1', 'myco-agent', 'title-summary', 'running', ?, ?, ?, ?, ?)`, [run, at, at, runner, `rc_${runner}`, `at_${run}`]);
      r.e.sqlite.run(`INSERT INTO agent_run_attempts (project_id, run_id, attempt_id, leased_by, claimed_at, owner_kind, runner_id) VALUES ('proj_1', ?, ?, ?, ?, 'runner', ?)`, [run, `at_${run}`, `rc_${runner}`, at, runner]);
      r.e.sqlite.run(`UPDATE agent_runs SET status = ?, completed_at = ? WHERE id = ?`, [status, at + 1, run]);
    };
    const runnerHead = (id: string) => r.e.sqlite.query('SELECT last_attempted, last_completed, last_failed FROM runner_head WHERE runner_id = ?').get(id) as Record<string, string | null>;
    const runId = (value: string | null) => value === null ? null : (JSON.parse(value) as { runId: string }).runId;
    return { ...r, finish, runnerHead, runId };
  }

  it('stops naming a run retention deleted, leaving every other runner and link alone', async () => {
    const r = await fleetRig();
    r.finish('run_old', 'rn_a', 'completed', NOW - 100);
    r.finish('run_fail', 'rn_a', 'failed', NOW + 50_000);
    r.finish('run_b', 'rn_b', 'completed', NOW - 90);
    expect(await pruneTerminalRuns(r.e.db, NOW, 10, undefined, NOW)).toBe(2);
    const a = r.runnerHead('rn_a');
    expect({ attempted: r.runId(a.last_attempted), completed: a.last_completed, failed: r.runId(a.last_failed) }).toEqual({ attempted: 'run_fail', completed: null, failed: 'run_fail' });
    expect(r.runnerHead('rn_b')).toEqual({ last_attempted: null, last_completed: null, last_failed: null });
    const details = (await readWorkerFleet(r.e.db, NOW)).find(row => row.credentialId === 'rn_a')!.runnerDetails!;
    expect(details).toMatchObject({ lastCompleted: null, lastFailed: { runId: 'run_fail' } });
  });

  it('keeps a link when an older run of the same runner goes', async () => {
    const r = await fleetRig();
    r.finish('run_old', 'rn_a', 'completed', NOW - 100);
    r.finish('run_new', 'rn_a', 'completed', NOW + 100);
    expect(await pruneTerminalRuns(r.e.db, NOW, 10, undefined, NOW)).toBe(1);
    expect(r.runId(r.runnerHead('rn_a').last_completed)).toBe('run_new');
  });
});

describe('the removed-runner view', () => {
  it('pages runners removed in the same millisecond without repeating or skipping any', async () => {
    const r = await rig();
    for (const id of ['rn_a', 'rn_b', 'rn_c', 'rn_d', 'rn_e']) r.e.sqlite.run(`INSERT INTO runners (id, name, state, created_at, removed_at) VALUES (?, ?, 'removed', 1, ?)`, [id, id, id === 'rn_e' ? NOW - 1 : NOW]);
    const seen: string[] = [];
    let after: { removedAt: number; id: string } | null = null;
    do {
      const page: Awaited<ReturnType<typeof readRemovedRunners>> = await readRemovedRunners(r.e.db, NOW, 2, after);
      seen.push(...page.runners.map(runner => runner.id));
      after = page.cursor;
    } while (after !== null);
    expect(seen).toEqual(['rn_a', 'rn_b', 'rn_c', 'rn_d', 'rn_e']);
  });
});

describe('legacy contact retirement', () => {
  const old = NOW - WORKER_CONTACT_RETENTION_MS - 1;

  it('deletes nothing and records no receipt when the export cannot be stored', async () => {
    const r = await rig();
    const worker = await r.admin('mem_a', 'studio');
    await recordWorkerContact(r.e.db, { credentialId: worker.tokenId, machineId: 'studio', offers: OFFER, capabilities: [], now: old });
    const failing = { ...r.e.serverEnv, blobs: { ...r.e.serverEnv.blobs, put: async () => { throw new Error('store down'); } } };
    expect(await pruneWorkerContacts(failing, NOW, WORKER_CONTACT_RETENTION_MS, 10)).toBe(0);
    expect(r.e.sqlite.query('SELECT credential_id FROM worker_contacts').all()).toHaveLength(1);
    expect(r.e.sqlite.query('SELECT 1 FROM legacy_contact_exports').all()).toHaveLength(0);
  });

  it('deletes nothing when the stored object does not match what was written', async () => {
    const r = await rig();
    const worker = await r.admin('mem_a', 'studio');
    await recordWorkerContact(r.e.db, { credentialId: worker.tokenId, machineId: 'studio', offers: OFFER, capabilities: [], now: old });
    const short = { ...r.e.serverEnv, blobs: { ...r.e.serverEnv.blobs, head: async () => null } };
    expect(await pruneWorkerContacts(short, NOW, WORKER_CONTACT_RETENTION_MS, 10)).toBe(0);
    expect(r.e.sqlite.query('SELECT credential_id FROM worker_contacts').all()).toHaveLength(1);
  });

  it('keeps a contact that reported again after its page was exported', async () => {
    const r = await rig();
    const worker = await r.admin('mem_a', 'studio');
    await recordWorkerContact(r.e.db, { credentialId: worker.tokenId, machineId: 'studio', offers: OFFER, capabilities: [], now: old });
    const blobs = r.e.serverEnv.blobs;
    const racing = { ...r.e.serverEnv, blobs: { ...blobs, put: async (...args: Parameters<typeof blobs.put>) => {
      const stored = await blobs.put(...args);
      r.e.sqlite.run('UPDATE worker_contacts SET last_seen_at = ? WHERE credential_id = ?', [NOW, worker.tokenId]);
      return stored;
    }, head: blobs.head.bind(blobs) } };
    expect(await pruneWorkerContacts(racing, NOW, WORKER_CONTACT_RETENTION_MS, 10)).toBe(0);
    expect(r.e.sqlite.query('SELECT last_seen_at FROM worker_contacts').all()).toEqual([{ last_seen_at: NOW }]);
  });
});

describe('harness reports under concurrency', () => {
  const trust = { id: 'codex', provisioned: true as const, state: 'trust_required' as const, action: 'Approve Codex.', hookRepairAt: 1 };
  const ready = { id: 'codex', provisioned: true as const, state: 'ready' as const };

  it('refuses a stale revision and leaves the winning trust state intact', async () => {
    const r = await rig();
    await recordProvisionedHarnessReport(r.e.db, 'machine_1', { harnesses: [trust] }, NOW);
    const stale = await machineHarnessState(r.e.db, 'machine_1');
    await recordProvisionedHarnessReport(r.e.db, 'machine_1', { harnesses: [{ ...trust, hookRepairAt: 2 }] }, NOW + 10);
    const committed = await commitHarnessReport(r.e.db, 'machine_1', stale.revision, [{ harness: 'codex', state: 'ready', action: null, ranAt: null, hookRepairAt: null, toolsDeployment: null, activityScope: null, sinceAt: NOW + 20, trustEpoch: 0, capabilityHash: 'x' }], NOW + 20);
    expect(committed).toBe(false);
    expect(r.e.sqlite.query('SELECT state, since_at, trust_epoch, hook_repair_at FROM machine_harness_reports').all())
      .toEqual([{ state: 'trust_required', since_at: NOW + 10, trust_epoch: 2, hook_repair_at: 2 }]);
  });

  it('re-derives from the winner when a concurrent report lands between its read and its commit', async () => {
    const r = await rig();
    await recordProvisionedHarnessReport(r.e.db, 'machine_1', { harnesses: [trust] }, NOW);
    const batch = r.e.db.batch.bind(r.e.db);
    let writes = 0;
    r.e.db.batch = async (statements) => {
      // The report's own read and its capture read are the first two batches; the third is its commit.
      if (++writes === 3) await recordProvisionedHarnessReport({ ...r.e.db, batch }, 'machine_1', { harnesses: [{ ...trust, hookRepairAt: 9 }] }, NOW + 5);
      return batch(statements);
    };
    await recordProvisionedHarnessReport(r.e.db, 'machine_1', { harnesses: [ready] }, NOW + 10);
    // Capture never confirmed the newest trust request, so the ready report cannot clear it, and it keeps the winner's instant.
    expect(r.e.sqlite.query('SELECT state, since_at, hook_repair_at FROM machine_harness_reports').all())
      .toEqual([{ state: 'trust_required', since_at: NOW + 5, hook_repair_at: 9 }]);
  });

  it('gives up without writing after repeated losses', async () => {
    const r = await rig();
    await recordProvisionedHarnessReport(r.e.db, 'machine_1', { harnesses: [ready] }, NOW);
    const batch = r.e.db.batch.bind(r.e.db);
    let bump = 100;
    r.e.db.batch = async (statements) => {
      r.e.sqlite.run('UPDATE machine_head SET harness_revision = ? WHERE machine_id = ?', [bump++, 'machine_1']);
      return batch(statements);
    };
    await expect(recordProvisionedHarnessReport(r.e.db, 'machine_1', { harnesses: [trust] }, NOW + 1)).rejects.toBeInstanceOf(HarnessReportContended);
    expect(r.e.sqlite.query('SELECT state FROM machine_harness_reports').all()).toEqual([{ state: 'ready' }]);
  });

  it('removes a harness the next report no longer names and leaves an unchanged one untouched', async () => {
    const r = await rig();
    const other = { ...ready, id: 'cursor' };
    await recordProvisionedHarnessReport(r.e.db, 'machine_1', { harnesses: [ready, other] }, NOW);
    await recordProvisionedHarnessReport(r.e.db, 'machine_1', { harnesses: [ready] }, NOW + 1);
    expect(r.e.sqlite.query('SELECT harness, reported_at FROM machine_harness_reports').all()).toEqual([{ harness: 'codex', reported_at: NOW }]);
  });
});

describe('the schema step', () => {
  it('splits a stored report into per-harness rows and drops what it cannot read, keeping other machines', () => {
    const db = new Database(':memory:');
    for (const step of SCHEMA_STEPS.filter(step => step.version < NEXT_S1C)) db.exec(step.statements.join(';\n'));
    db.run(`INSERT INTO machine_harness_reports (machine_id, harnesses, reported_at) VALUES
      ('good', '[{"id":"codex","provisioned":true,"state":"trust_required","action":"Do it.","sinceAt":5,"hookRepairAt":3},{"id":"cursor","provisioned":true,"state":"ready","sinceAt":6,"ranAt":7}]', 9),
      ('broken', 'not json', 9), ('partial', '[{"id":"codex","state":"ready"}]', 9)`);
    db.exec(SCHEMA_STEPS.find(step => step.version === NEXT_S1C)!.statements.join(';\n'));
    expect(db.query('SELECT machine_id, harness, position, state, action, since_at, trust_epoch, ran_at, hook_repair_at FROM machine_harness_reports ORDER BY machine_id, position').all()).toEqual([
      { machine_id: 'good', harness: 'codex', position: 0, state: 'trust_required', action: 'Do it.', since_at: 5, trust_epoch: 1, ran_at: null, hook_repair_at: 3 },
      { machine_id: 'good', harness: 'cursor', position: 1, state: 'ready', action: null, since_at: 6, trust_epoch: 0, ran_at: 7, hook_repair_at: null },
    ]);
    db.close();
  });
});

describe('credential activation', () => {
  const auth = (over: Partial<RunnerAuth> & { predecessorId: string }): RunnerAuth & { predecessorId: string } => ({
    runnerId: 'rn_a', credentialId: 'rc_s1', epoch: 1, state: 'enabled', name: 'a', issuedAt: NOW, expiresAt: NOW + 1_000_000, firstUsedAt: null, ...over,
  });

  async function runnerRig() {
    const r = await rig();
    r.e.sqlite.run(`INSERT INTO runners (id, name, created_at) VALUES ('rn_a', 'a', ?)`, [NOW]);
    const credential = (id: string, predecessor: string | null, hash: string) => r.e.sqlite.run(
      `INSERT INTO runner_credentials (id, runner_id, token_hash, epoch, issued_at, expires_at, predecessor_id, lineage_root) VALUES (?, 'rn_a', ?, 1, ?, ?, ?, 'rc_p')`, [id, hash, NOW, NOW + 1_000_000, predecessor]);
    credential('rc_p', null, 'p');
    credential('rc_s1', 'rc_p', 's1');
    return r;
  }
  const row = (r: Awaited<ReturnType<typeof runnerRig>>, id: string) => r.e.sqlite.query('SELECT revoked_at, first_used_at FROM runner_credentials WHERE id = ?').get(id);

  it('leaves the predecessor and the replaced successor alone when another refresh already revoked that successor', async () => {
    const r = await runnerRig();
    r.e.sqlite.run('UPDATE runner_credentials SET revoked_at = ? WHERE id = ?', [NOW + 1, 'rc_s1']);
    await activateRunnerSuccessor(r.e.db, auth({ predecessorId: 'rc_p' }), NOW + 2);
    expect(row(r, 'rc_p')).toEqual({ revoked_at: null, first_used_at: null });
    expect(row(r, 'rc_s1')).toEqual({ revoked_at: NOW + 1, first_used_at: null });
  });

  it('stamps a live successor and revokes its predecessor', async () => {
    const r = await runnerRig();
    await activateRunnerSuccessor(r.e.db, auth({ predecessorId: 'rc_p' }), NOW + 2);
    expect(row(r, 'rc_p')).toEqual({ revoked_at: NOW + 2, first_used_at: null });
    expect(row(r, 'rc_s1')).toEqual({ revoked_at: null, first_used_at: NOW + 2 });
  });
});

describe('the fleet page', () => {
  const runner = (name: string, id: string, over: Partial<RunnerFleetRecord> = {}): RunnerFleetRecord => ({
    id, name, state: 'enabled', connected: true, busy: null, readiness: { state: 'ready', code: 'ready', reason: '', observedAt: NOW }, ...over,
  } as RunnerFleetRecord);

  it('pages active runners by name across a stable cursor and totals the whole fleet', () => {
    const fleet = [runner('c', 'rn_3'), runner('a', 'rn_1', { state: 'paused', connected: false }), runner('b', 'rn_2', { busy: { runId: 'r' } as RunnerFleetRecord['busy'] })];
    const first = pageRunners(fleet, 2, null);
    expect(first.rows.map(row => row.id)).toEqual(['rn_1', 'rn_2']);
    expect(first.cursor).not.toBeNull();
    const parsed = parseFleetPage(new URL(`https://s/?cursor=${encodeURIComponent(first.cursor!)}`));
    if (typeof parsed === 'string') throw new Error(parsed);
    const next = pageRunners(fleet, 2, parsed.cursor);
    expect(next).toMatchObject({ rows: [{ id: 'rn_3' }], cursor: null });
    expect(fleetTotals(fleet)).toEqual({ active: 3, enabled: 2, paused: 1, connected: 2, busy: 1, ready: 2 });
    expect(parseFleetPage(new URL('https://s/?cursor=%25%25'))).toBe('invalid_cursor');
    expect(parseFleetPage(new URL('https://s/?limit=2.5'))).toBe('invalid_limit');
  });

  it('names the oldest queued run by when it was queued, not by its id', async () => {
    const r = await rig();
    r.e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
    const queue = (id: string, at: number) => r.e.sqlite.run(`INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at) VALUES (?, 'proj_1', 'myco-agent', 'title-summary', 'queued', ?)`, [id, at]);
    queue('run_a', NOW + 5);
    queue('run_z', NOW);
    expect(r.e.sqlite.query('SELECT oldest_run_id, oldest_queued_at FROM task_runtime').all()).toEqual([{ oldest_run_id: 'run_z', oldest_queued_at: NOW }]);
  });
});

describe('queue presence while the queues build', () => {
  it('reports queued work from the source table, never as no work', async () => {
    const r = await rig();
    r.e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
    r.e.sqlite.run(`INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at) VALUES ('run_a', 'proj_1', 'myco-agent', 'title-summary', 'queued', ?)`, [NOW]);
    await resetProjectionCatchup(r.e.db);
    expect(await unclaimedQueued(r.e.db)).toBe(true);
    expect(await hasQueuedRun(r.e.db, 'other')).toBe(true);
    expect(await hasQueuedRun(r.e.db, 'budget')).toBe(false);
    r.e.sqlite.run(`DELETE FROM agent_runs WHERE id = 'run_a'`);
    expect(await unclaimedQueued(r.e.db)).toBe(false);
    expect(await hasQueuedRun(r.e.db)).toBe(false);
  });
});
