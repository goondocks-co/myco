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

  it('carries only the fields it declares for a worker, so a producer growing one does not widen the document', async () => {
    const r = await rig();
    await ensureMember(r.db, 'mem_w1', NOW, 'admin', 'a worker');
    const credential = await issueMemberToken(r.db, { memberId: 'mem_w1', machineId: 'build-box' }, NOW);
    await recordWorkerContact(r.db, { credentialId: credential.tokenId, machineId: 'build-box', offers: [], capabilities: [], reason: 'no_work', now: NOW });
    const document = await deploymentDiagnostics(r.serverEnv, NOW);
    expect(Object.keys(document.workers!.fleet[0]!).sort())
      .toEqual(['busy', 'capabilities', 'credentialId', 'eligible', 'lastReason', 'lastSeenAt', 'machineId', 'offers', 'recent']);
  });

  it('answers what it is configured to run, and the work it declares, from the registry', async () => {
    const r = await rig();
    const document = await deploymentDiagnostics(r.serverEnv, NOW);
    expect(document.declaredWork.length).toBe(declaredWork().length);
    expect(document.declaredWork.some((w) => w.kind === 'job')).toBe(true);
    expect(document.refusalVocabulary.length).toBeGreaterThan(0);
    expect(document.omissions.join(' ')).toContain('credentials');
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
