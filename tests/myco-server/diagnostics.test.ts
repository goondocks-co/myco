/**
 * What the Deployment's diagnostics document may say.
 *
 * It is built from the producers the Status page reads, served to an owner and
 * to nobody else, and it carries no free text: a store this handler could not
 * question is reported by a named state rather than by the error it raised, and
 * a refusal is a term from the closed vocabulary. The store-unusable branch is
 * the one that matters most — zeros there would read as "nothing attached" on the
 * one surface whose job is to say that nothing is known.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { deploymentDiagnostics, declaredWork } from '@myco-server-worker/core/diagnostics.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { recordWorkerContact } from '@myco-server-worker/core/worker-contacts.js';
import { sqliteEnv, memberHeaders } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';

const NOW = 1_800_000_000_000;

async function rig() {
  const fixture = sqliteEnv();
  fixture.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  // `fixture.env` is what a request is served with; the pipeline binds the store
  // per request, so a direct call is handed one.
  return { ...fixture, env: { ...fixture.env, ...OWNER_ENV }, serverEnv: { ...fixture.env, ...OWNER_ENV, db: fixture.db } };
}

describe('the Deployment names what it is configured to do', () => {
  it('serves its schema, capabilities, workers, queue and projects to an owner', async () => {
    const r = await rig();
    await ensureMember(r.db, 'mem_w1', NOW, 'admin', 'a worker');
    const credential = await issueMemberToken(r.db, { memberId: 'mem_w1', machineId: 'build-box' }, NOW);
    await recordWorkerContact(r.db, {
      credentialId: credential.tokenId, machineId: 'build-box',
      offers: [{ id: 'codex', authenticated: false }], capabilities: ['repository-checkout'], reason: 'no_harness', now: NOW,
    });
    r.sqlite.run(
      `INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at, held_by)
       VALUES ('run_q', 'proj_1', 'myco-agent', 'title-summary', 'queued', ?, 'worker')`,
      [NOW],
    );

    const document = await deploymentDiagnostics(r.serverEnv, NOW);
    expect(document).toMatchObject({ bundle: 'myco.deployment.diagnostics', store: 'readable' });
    expect(document.schema.matches).toBe(true);
    expect(document.workers?.runsQueued).toBe(1);
    expect(document.workers?.fleet[0]).toMatchObject({ machineId: 'build-box', lastReason: 'no_harness', recent: true });
    expect(document.queuedRuns?.[0]).toMatchObject({ runId: 'run_q', task: 'title-summary', heldBy: 'worker', launched: false });
    expect(document.projects?.some((p) => p.projectId === 'proj_1')).toBe(true);
    expect(document.ingestBacklog).toMatchObject({ pendingTranscriptBytes: 0, pendingImportedTranscripts: 0 });
  });

  it('counts a stored claim reason outside the vocabulary rather than carrying its text', async () => {
    const r = await rig();
    await ensureMember(r.db, 'mem_w1', NOW, 'admin', 'a worker');
    const credential = await issueMemberToken(r.db, { memberId: 'mem_w1', machineId: 'build-box' }, NOW);
    await recordWorkerContact(r.db, { credentialId: credential.tokenId, machineId: 'build-box', offers: [], capabilities: [], reason: 'no_work', now: NOW });
    // The column carries no constraint, so an older or damaged writer can leave any
    // string where a reason belongs. This is that row.
    r.sqlite.run(`UPDATE worker_contacts SET last_reason = ? WHERE credential_id = ?`,
      ['refused: /Users/dev/.myco/secrets.env could not be read', credential.tokenId]);

    const document = await deploymentDiagnostics(r.serverEnv, NOW);
    expect(document.workers?.fleet[0]).toMatchObject({ lastReason: null, unknownReason: 1 });
    expect(JSON.stringify(document)).not.toContain('secrets.env');
    expect(JSON.stringify(document)).not.toContain('refused:');
  });

  it('carries a known reason and counts none unknown', async () => {
    const r = await rig();
    await ensureMember(r.db, 'mem_w1', NOW, 'admin', 'a worker');
    const credential = await issueMemberToken(r.db, { memberId: 'mem_w1', machineId: 'build-box' }, NOW);
    await recordWorkerContact(r.db, { credentialId: credential.tokenId, machineId: 'build-box', offers: [], capabilities: [], reason: 'no_harness', now: NOW });

    const document = await deploymentDiagnostics(r.serverEnv, NOW);
    expect(document.workers?.fleet[0]).toMatchObject({ lastReason: 'no_harness', unknownReason: 0 });
  });

  it('records no reason for a lease holder that has never reported one', async () => {
    const r = await rig();
    await ensureMember(r.db, 'mem_w1', NOW, 'admin', 'a worker');
    const credential = await issueMemberToken(r.db, { memberId: 'mem_w1', machineId: 'legacy-box' }, NOW);
    r.sqlite.run(
      `INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at, started_at, leased_by, lease_expires_at)
       VALUES ('run_held', 'proj_1', 'myco-agent', 'title-summary', 'running', ?, ?, ?, ?)`,
      [NOW, NOW, credential.tokenId, NOW + 90_000],
    );
    const document = await deploymentDiagnostics(r.serverEnv, NOW);
    expect(document.workers?.fleet[0]).toMatchObject({ lastReason: null, unknownReason: null, lastSeenAt: 0 });
  });

  it('counts a queued row whose task and holder are outside their vocabularies, keeping the run id', async () => {
    const r = await rig();
    const rows: [string, string, string][] = [
      ['run_odd', 'exfiltrate /Users/dev/.ssh/id_ed25519', 'a reason the operator typed'],
      // A key every object inherits is not a declaration, and must not read as one.
      ['run_proto', 'constructor', '__proto__'],
      ['run_proto2', 'toString', 'constructor'],
    ];
    for (const [id, task, heldBy] of rows) {
      r.sqlite.run(
        `INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at, held_by)
         VALUES (?, 'proj_1', 'myco-agent', ?, 'queued', ?, ?)`,
        [id, task, NOW, heldBy],
      );
    }
    const document = await deploymentDiagnostics(r.serverEnv, NOW);
    for (const [id] of rows) {
      // The run id stays: it is what correlates the row with the queue.
      expect(document.queuedRuns?.find((row) => row.runId === id))
        .toMatchObject({ runId: id, task: null, unknownTask: 1, heldBy: null, unknownHeldBy: 1 });
    }
    expect(JSON.stringify(document)).not.toContain('id_ed25519');
    expect(JSON.stringify(document)).not.toContain('operator typed');
  });

  it('keeps a retained task and a holder the shared vocabulary names', async () => {
    const r = await rig();
    r.sqlite.run(
      `INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at, held_by)
       VALUES ('run_ok', 'proj_1', 'myco-agent', 'title-summary', 'queued', ?, 'worker')`,
      [NOW],
    );
    const document = await deploymentDiagnostics(r.serverEnv, NOW);
    expect(document.queuedRuns?.find((row) => row.runId === 'run_ok'))
      .toMatchObject({ task: 'title-summary', unknownTask: 0, heldBy: 'worker', unknownHeldBy: 0 });
  });

  it('names no task for a held run whose stored task the catalogue does not retain', async () => {
    const r = await rig();
    await ensureMember(r.db, 'mem_w1', NOW, 'admin', 'a worker');
    const credential = await issueMemberToken(r.db, { memberId: 'mem_w1', machineId: 'build-box' }, NOW);
    r.sqlite.run(
      `INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at, started_at, leased_by, lease_expires_at)
       VALUES ('run_busy', 'proj_1', 'myco-agent', ?, 'running', ?, ?, ?, ?)`,
      ['whatever the caller sent', NOW, NOW, credential.tokenId, NOW + 90_000],
    );
    const document = await deploymentDiagnostics(r.serverEnv, NOW);
    expect(document.workers?.fleet[0]?.busy).toMatchObject({ runId: 'run_busy', task: null, unknownTask: 1 });
    expect(JSON.stringify(document)).not.toContain('whatever the caller sent');
  });

  it('carries only the fields it declares for a worker, so a producer growing one does not widen the document', async () => {
    const r = await rig();
    await ensureMember(r.db, 'mem_w1', NOW, 'admin', 'a worker');
    const credential = await issueMemberToken(r.db, { memberId: 'mem_w1', machineId: 'build-box' }, NOW);
    await recordWorkerContact(r.db, { credentialId: credential.tokenId, machineId: 'build-box', offers: [], capabilities: [], reason: 'no_work', now: NOW });
    const document = await deploymentDiagnostics(r.serverEnv, NOW);
    expect(Object.keys(document.workers!.fleet[0]!).sort())
      .toEqual(['busy', 'capabilities', 'credentialId', 'eligible', 'lastReason', 'lastSeenAt', 'machineId', 'offers', 'recent', 'unknownCapabilities', 'unknownOffers', 'unknownReason']);
  });

  it('carries no capability name it does not know, so a worker cannot place its own text in the document', async () => {
    const r = await rig();
    await ensureMember(r.db, 'mem_w1', NOW, 'admin', 'a worker');
    const credential = await issueMemberToken(r.db, { memberId: 'mem_w1', machineId: 'build-box' }, NOW);
    // A worker reports whatever it likes; the endpoint stores every string it is given.
    await recordWorkerContact(r.db, {
      credentialId: credential.tokenId, machineId: 'build-box', offers: [],
      capabilities: ['repository-checkout', 'mt_thisisaverysecrettokenvalue', 'whatever-it-calls-itself'],
      reason: 'no_work', now: NOW,
    });

    const document = await deploymentDiagnostics(r.serverEnv, NOW);
    const worker = document.workers!.fleet[0]!;
    expect(worker.capabilities).toEqual(['repository-checkout']);
    expect(worker.unknownCapabilities).toBe(2);
    expect(JSON.stringify(document)).not.toContain('mt_thisisaverysecrettokenvalue');
  });

  it('answers what it is configured to run, and the work it declares, from the registry', async () => {
    const r = await rig();
    const document = await deploymentDiagnostics(r.serverEnv, NOW);
    expect(document.declaredWork.length).toBe(declaredWork().length);
    expect(document.declaredWork.some((w) => w.kind === 'job')).toBe(true);
    expect(document.refusalVocabulary.length).toBeGreaterThan(0);
    expect(document.omissions.join(' ')).toContain('credentials');
  });

  it('counts unknown worker offers without exporting their supplied identifiers', async () => {
    const r = await rig();
    await ensureMember(r.db, 'mem_w1', NOW, 'admin', 'a worker');
    const credential = await issueMemberToken(r.db, { memberId: 'mem_w1', machineId: 'build-box' }, NOW);
    await recordWorkerContact(r.db, {
      credentialId: credential.tokenId, machineId: 'build-box', capabilities: [], reason: 'no_work', now: NOW,
      offers: [{ id: 'codex', authenticated: true }, { id: 'sk_synthetic_private_value', authenticated: false }],
    });
    const document = await deploymentDiagnostics(r.serverEnv, NOW);
    expect(document.workers?.fleet[0]).toMatchObject({ offers: [{ id: 'codex', authenticated: true }], unknownOffers: 1 });
    expect(JSON.stringify(document)).not.toContain('sk_synthetic_private_value');
  });
});

describe('a store the handler could not question is not an empty Deployment', () => {
  it('answers a named state with nulls, never zero workers and no projects', async () => {
    const r = await rig();
    const broken = {
      ...r.serverEnv,
      db: { prepare: () => { throw new Error('/var/data/myco.sqlite is not a database'); } } as unknown as typeof r.serverEnv.db,
    };
    const document = await deploymentDiagnostics(broken, NOW);
    expect(document.store).toBe('unavailable');
    expect(document.schema).toEqual({ expected: document.schema.expected, found: null, matches: false });
    expect(document.workers).toBeNull();
    expect(document.queuedRuns).toBeNull();
    expect(document.projects).toBeNull();
    expect(document.ingestBacklog).toBeNull();
    // The platform's message never travels; the state names the condition.
    expect(JSON.stringify(document)).not.toContain('myco.sqlite');
    // What this server is configured to do is still answered.
    expect(document.declaredWork.length).toBeGreaterThan(0);
  });
});

describe('the document is an owner surface', () => {
  it('is served to an owner as a downloadable attachment', async () => {
    const r = await rig();
    const res = await worker.fetch(await asOwner('/api/diagnostics'), r.env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toContain('attachment; filename="myco-diagnostics-');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json() as { bundle: string }).bundle).toBe('myco.deployment.diagnostics');
  });

  it('is refused to a member credential, which is not the owner path', async () => {
    const r = await rig();
    await ensureMember(r.db, 'mem_m1', NOW, 'member', 'a member');
    const credential = await issueMemberToken(r.db, { memberId: 'mem_m1', machineId: 'laptop' }, NOW);
    const res = await worker.fetch(new Request('https://s/api/diagnostics', { headers: memberHeaders(credential.token) }), r.env);
    expect(res.status).not.toBe(200);
  });
});
