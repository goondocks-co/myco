import { expect } from 'bun:test';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { lit, memberHeadersFor, type ParityScenario } from '../harness.ts';

export const canopy: ParityScenario = {
  name: 'canopy: held committed-source map publication and shared project read',
  async run(target) {
    const now = Date.now();
    await target.sql(`INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES (${lit(target.projectId)},'Canopy parity',${now})`);
    const owner = async (path: string, method = 'GET', body?: unknown) => {
      const res = await fetch(target.url + path, { method, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect(res.status).toBe(200);
      return await res.json() as any;
    };
    const repository = { url: 'https://example.test/map.git', branch: 'main', commit: 'a'.repeat(40) };
    const endpoint = `/api/projects/${target.projectId}`;
    const connected = await owner(`${endpoint}/repository`, 'PUT', { ...repository, revision: null });
    const token = `map-parity-${now}`.padEnd(43, 'x');
    const tokenId = `mt_map_${now}`;
    const runId = `map_${now}`;
    await target.sql(`INSERT OR IGNORE INTO members(id,label,created_at) VALUES ('mem_harness','harness',${now})`);
    await target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,bytes_written,lineage_root,lineage_started_at)
      VALUES (${lit(tokenId)},'mem_harness','harness',${lit(await sha256Hex(token))},${now},${now + 3_600_000},0,${lit(tokenId)},${now})`);
    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,dispatched_by,run_context)
      VALUES (${lit(target.projectId)},${lit(runId)},'user','canopy-map','running',${now},${lit(tokenId)},'{}')`);
    const asRun = async (path: string, body: Record<string, unknown>, credential = token) => {
      const res = await fetch(target.url + path, { method: 'POST', headers: memberHeadersFor(credential, target.projectId, { 'content-type': 'application/json' }), body: JSON.stringify({ runId, ...body }) });
      expect(res.status).toBe(200);
      return await res.json() as any;
    };
    expect((await owner(`${endpoint}/canopy-map`)).map).toBeNull();
    expect((await asRun('/runs/repository', repository)).pin.commit).toBe(repository.commit);
    const prepared = await asRun('/runs/canopy-map', { op: 'prepare' });
    expect(prepared.map).toBeNull();
    expect(prepared.settings.defaultPatterns).toContain('.git');
    const source = { inputHash: 'b'.repeat(64), priorRevision: null };
    expect((await asRun('/runs/canopy-map', { op: 'pin', source })).source).toEqual(source);
    const evidence = { path: 'src/main.ts', sha256: 'c'.repeat(64) };
    const artifact = { directories: [{ path: 'src', annotation: 'Source.', groundedIn: [evidence] }], domains: [
      { id: 'main', title: 'Main', files: [{ path: evidence.path, annotation: 'Starts the application.', groundedIn: [evidence] }] },
    ] };
    expect((await asRun('/runs/canopy-map', { op: 'write', artifact }, target.memberToken)).held).toBe(false);
    expect((await asRun('/runs/canopy-map', { op: 'write', artifact })).written).toBe(true);
    const stored = (await owner(`${endpoint}/canopy-map`)).map;
    expect(stored.repository).toEqual(repository);
    expect(stored.artifact).toEqual(artifact);
    expect(stored.content).toContain('Map Provenance');
    expect((await asRun('/runs/canopy-map', { op: 'write', artifact })).written).toBe(true);
    expect((await owner(`${endpoint}/canopy-map`)).map.revision).toBe(stored.revision);
    await target.sql(`UPDATE agent_runs SET status='completed' WHERE project_id=${lit(target.projectId)} AND id=${lit(runId)}`);
    expect((await asRun('/runs/canopy-map', { op: 'write', artifact })).held).toBe(false);
    await owner(`${endpoint}/repository`, 'DELETE', { revision: connected.repository.revision });
    await target.sql(`UPDATE member_credentials SET revoked_at=${Date.now()} WHERE id=${lit(tokenId)}`);
  },
};
