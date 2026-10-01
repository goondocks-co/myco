import { expect } from 'bun:test';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { lit, MEMBER_ID, memberHeadersFor, type ParityScenario } from '../harness.ts';

export const repositories: ParityScenario = {
  name: 'repositories: sealed project access and immutable held-run commit',
  async run(target) {
    await target.sql(`INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES (${lit(target.projectId)},'Repository parity',${Date.now()})`);
    const endpoint = `/api/projects/${target.projectId}/repository`;
    const source = 'https://github.com/example/source.git';
    const secret = 'parity-repository-token-with-no-real-permissions';
    const sha = 'a'.repeat(40);
    const owner = async (method: string, body?: unknown) => {
      const result = await fetch(target.url + endpoint, { method, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: result.status, body: await result.json() as any };
    };
    const prior = await owner('GET');
    expect(prior.status).toBe(200);
    expect(prior.body.repository).toBeNull();
    const saved = await owner('PUT', { url: source, branch: 'main', revision: null, credential: { username: 'reader', token: secret } });
    expect(saved.status).toBe(200);
    expect(saved.body.repository.updatedBy).toBe(MEMBER_ID);
    expect(saved.body.repository.credential.readable).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain(secret);
    const rows = await target.sql(`SELECT ciphertext FROM deployment_secrets WHERE name LIKE ${lit('repository:' + target.projectId + ':%')}`);
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect((await owner('PUT', { url: source, branch: 'main', revision: 'stale' })).status).toBe(409);

    // A worker's leased run, taken the way a worker takes one: the claim writes the checkout the run holds and names
    // the run's own credential. The worker's credential is written for a token this scenario chose, the store keeping a
    // digest of it, and the queued row sits at the front of the queue so the claim takes it.
    const now = Date.now();
    const workerToken = `repository-worker-${now}`.padEnd(43, 'x');
    const workerTokenId = `mt_repository_worker_${now}`;
    await target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,bytes_written,lineage_root,lineage_started_at)
      VALUES (${lit(workerTokenId)},${lit(MEMBER_ID)},'machine_parity',${lit(await sha256Hex(workerToken))},${now},${now + 3_600_000},0,${lit(workerTokenId)},${now})`);
    await target.sql(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ${now})`);
    await target.sql(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (${lit(target.projectId)}, 'vault_evolution', 1, ${now}, ${lit(MEMBER_ID)})`);
    const queuedId = `repository-${now}`;
    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context)
      VALUES (${lit(target.projectId)},${lit(queuedId)},'myco-agent','vault-seed','queued',1,'worker',${lit(JSON.stringify({ serverUrl: target.url, actor: MEMBER_ID, timeoutSeconds: 300 }))},'{}')`);
    const claimed = await fetch(target.url + '/worker/claim', {
      method: 'POST', headers: memberHeadersFor(workerToken, target.projectId, { 'content-type': 'application/json' }),
      body: JSON.stringify({ harnesses: [{ id: 'claude-code', authenticated: true }], capabilities: WORKER_CAPABILITIES }),
    });
    expect(claimed.status).toBe(200);
    const claim = await claimed.json() as { claimed: boolean; run: { id: string; runToken: string } };
    expect({ claimed: claim.claimed, run: claim.run?.id }).toEqual({ claimed: true, run: queuedId });
    const runId = claim.run.id;
    const runToken = claim.run.runToken;
    const asWorker = async (body: Record<string, unknown>, credential = workerToken) => {
      const result = await fetch(target.url + '/worker/repository', { method: 'POST', headers: memberHeadersFor(credential, target.projectId, { 'content-type': 'application/json' }), body: JSON.stringify({ projectId: target.projectId, runId, ...body }) });
      expect(result.status).toBe(200);
      return await result.json() as any;
    };
    expect((await asWorker({})).repository.credential.token).toBe(secret);
    expect((await asWorker({}, target.memberToken)).held).toBe(false);
    expect((await asWorker({ url: source, branch: 'main', commit: sha })).pin.commit).toBe(sha);
    expect((await asWorker({ url: source, branch: 'main', commit: 'b'.repeat(40) })).pin.commit).toBe(sha);
    expect((await asWorker({})).repository.commit).toBe(sha);
    // The container harness's own repository route is retired: the run's credential meets it as no route at all.
    const retired = await fetch(target.url + '/runs/repository', { method: 'POST', headers: memberHeadersFor(runToken, target.projectId, { 'content-type': 'application/json' }), body: JSON.stringify({ runId }) });
    expect(retired.status).toBe(401);
    await target.sql(`UPDATE agent_runs SET status='completed' WHERE project_id=${lit(target.projectId)} AND id=${lit(runId)}`);
    expect((await asWorker({})).held).toBe(false);
    const edited = await owner('PUT', { url: 'https://example.test/new.git', branch: 'main', revision: saved.body.repository.revision });
    expect(edited.status).toBe(200);
    expect(edited.body.repository.credential).toBeNull();
    expect((await owner('DELETE', { revision: edited.body.repository.revision })).status).toBe(200);
    expect((await owner('GET')).body.repository).toBeNull();
    await target.sql(`UPDATE member_credentials SET revoked_at=${Date.now()} WHERE id = ${lit(workerTokenId)}`);
  },
};
