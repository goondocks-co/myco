import { expect } from 'bun:test';
import { MAP_ACTION, MAP_UNCHANGED_ACTION } from '@goondocks/myco-shared/canopy';
import { MAX_REPOSITORY_HISTORY_DEPTH } from '@goondocks/myco-shared/repository';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { lit, memberHeadersFor, type ParityScenario } from '../harness.ts';

/** How long the seeded lease holds: well past the scenario, so no sweep takes the run mid-way. */
const LEASE_MS = 600_000;

/**
 * A map run on the worker path, on both targets: the worker's repository step
 * pins the commit and the map input together, the run writes its map over its
 * own credential, the worker's end is judged against the stored row, a second
 * pass over the same commit closes unchanged, and a member reads the map.
 */
export const canopy: ParityScenario = {
  name: 'canopy: a worker map run pinned to its commit, closed on its map, and read over MCP',
  async run(target) {
    const now = Date.now();
    await target.sql(`INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES (${lit(target.projectId)},'Canopy parity',${now})`);
    const owner = async (path: string, method = 'GET', body?: unknown) => {
      const res = await fetch(target.url + path, { method, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect(res.status).toBe(200);
      return await res.json() as any;
    };
    const post = async (path: string, credential: string, body: unknown) => {
      const res = await fetch(target.url + path, { method: 'POST', headers: memberHeadersFor(credential, target.projectId, { 'content-type': 'application/json' }), body: JSON.stringify(body) });
      expect(res.status).toBe(200);
      return await res.json() as any;
    };
    const tool = async (credential: string, name: string, args: Record<string, unknown>) =>
      (await post('/mcp', credential, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result.structuredContent.result;

    const source = { url: 'https://example.test/map.git', branch: 'main' };
    const commit = 'a'.repeat(40);
    const endpoint = `/api/projects/${target.projectId}`;
    const connected = await owner(`${endpoint}/repository`, 'PUT', { ...source, revision: null });
    const workerId = String((await target.sql(`SELECT id FROM member_credentials WHERE token_hash = ${lit(await sha256Hex(target.memberToken))}`))[0]?.id);
    await target.sql(`INSERT OR IGNORE INTO members(id,label,created_at) VALUES ('mem_harness','harness',${now})`);
    await target.sql(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ${now})`);
    const issued: string[] = [];

    /** A map run the worker holds, as a claim leaves it: running, leased, its checkout named. */
    const leasedRun = async (label: string) => {
      const token = `map-parity-${label}-${now}`.padEnd(43, 'x');
      const tokenId = `mt_map_${label}_${now}`;
      const runId = `map_${label}_${now}`;
      issued.push(tokenId);
      await target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,bytes_written,lineage_root,lineage_started_at)
        VALUES (${lit(tokenId)},'mem_harness','harness',${lit(await sha256Hex(token))},${now},${now + 3_600_000},0,${lit(tokenId)},${now})`);
      await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,dispatched_by,leased_by,lease_expires_at,run_context)
        VALUES (${lit(target.projectId)},${lit(runId)},'myco-agent','canopy-map','running',${now},${lit(tokenId)},${lit(workerId)},${now + LEASE_MS},
          ${lit(JSON.stringify({ checkout: { ...source, historyDepth: MAX_REPOSITORY_HISTORY_DEPTH } }))})`);
      const pinned = await post('/worker/repository', target.memberToken, { projectId: target.projectId, runId, ...source, commit });
      expect(pinned.pin).toEqual({ ...source, commit });
      return { token, runId };
    };
    const end = async (runId: string) => post('/worker/end', target.memberToken, { projectId: target.projectId, runId, status: 'completed' });

    try {
      expect((await owner(`${endpoint}/canopy-map`)).map).toBeNull();
      const first = await leasedRun('first');
      expect(await tool(first.token, 'myco_run_map', { op: 'get' })).toMatchObject({ commit, unchanged: false, map: null });
      const evidence = { path: 'src/main.ts', sha256: 'c'.repeat(64) };
      const artifact = { directories: [{ path: 'src', annotation: 'Source.', groundedIn: [evidence] }], domains: [
        { id: 'main', title: 'Main', files: [{ path: evidence.path, annotation: 'Starts the application.', groundedIn: [evidence] }] },
      ] };
      expect(await tool(first.token, 'myco_run_map', { op: 'write', artifact })).toMatchObject({ written: true, commit });
      await tool(first.token, 'myco_run', { op: 'report', action: MAP_ACTION, summary: 'mapped' });
      expect(await end(first.runId)).toMatchObject({ ended: true, status: 'completed' });
      const stored = (await owner(`${endpoint}/canopy-map`)).map;
      expect(stored).toMatchObject({ repository: { ...source, commit }, artifact, sourceRunId: first.runId });

      const second = await leasedRun('second');
      expect(await tool(second.token, 'myco_run_map', { op: 'get' })).toMatchObject({ commit, unchanged: true, map: { revision: stored.revision } });
      await tool(second.token, 'myco_run', { op: 'report', action: MAP_UNCHANGED_ACTION, summary: 'unchanged' });
      expect(await end(second.runId)).toMatchObject({ ended: true, status: 'completed' });

      const read = await tool(target.memberToken, 'myco_cortex', { op: 'canopy_map' });
      expect(read).toMatchObject({ project_id: target.projectId, revision: stored.revision, repository: { ...source, commit } });
      expect(read.content).toContain('Map Provenance');
    } finally {
      await owner(`${endpoint}/repository`, 'DELETE', { revision: connected.repository.revision });
      for (const id of issued) await target.sql(`UPDATE member_credentials SET revoked_at=${Date.now()} WHERE id=${lit(id)} AND revoked_at IS NULL`);
    }
  },
};
