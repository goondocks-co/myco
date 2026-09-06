import { expect } from 'bun:test';
import { sha256Hex } from '@myco-server-worker/hash.js';
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

    const now = Date.now();
    const runId = `repository-${now}`;
    const token = `repository-parity-${now}`.padEnd(43, 'x');
    const tokenId = `mt_repository_${now}`;
    await target.sql(`INSERT OR IGNORE INTO members(id,label,created_at) VALUES ('mem_harness','harness',${now})`);
    await target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,bytes_written,lineage_root,lineage_started_at)
      VALUES (${lit(tokenId)},'mem_harness','harness',${lit(await sha256Hex(token))},${now},${now + 3_600_000},0,${lit(tokenId)},${now})`);
    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,dispatched_by,run_context)
      VALUES (${lit(target.projectId)},${lit(runId)},'user','skill-generate','running',${now},${lit(tokenId)},'{}')`);
    const asRun = async (body: Record<string, unknown>, credential = token, project = target.projectId) => {
      const result = await fetch(target.url + '/runs/repository', { method: 'POST', headers: memberHeadersFor(credential, project, { 'content-type': 'application/json' }), body: JSON.stringify({ runId, ...body }) });
      expect(result.status).toBe(200);
      return await result.json() as any;
    };
    expect((await asRun({})).repository.credential.token).toBe(secret);
    expect(await asRun({}, target.memberToken)).toEqual({ persisted: true, held: false });
    expect((await asRun({ url: source, branch: 'main', commit: sha })).pin.commit).toBe(sha);
    expect((await asRun({ url: source, branch: 'main', commit: 'b'.repeat(40) })).pin.commit).toBe(sha);
    expect((await asRun({})).repository.commit).toBe(sha);
    await target.sql(`UPDATE agent_runs SET status='completed' WHERE project_id=${lit(target.projectId)} AND id=${lit(runId)}`);
    expect(await asRun({})).toEqual({ persisted: true, held: false });
    const edited = await owner('PUT', { url: 'https://example.test/new.git', branch: 'main', revision: saved.body.repository.revision });
    expect(edited.status).toBe(200);
    expect(edited.body.repository.credential).toBeNull();
    expect((await owner('DELETE', { revision: edited.body.repository.revision })).status).toBe(200);
    expect((await owner('GET')).body.repository).toBeNull();
    await target.sql(`UPDATE member_credentials SET revoked_at=${Date.now()} WHERE id=${lit(tokenId)}`);
  },
};
