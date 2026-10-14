import { expect } from 'bun:test';
import { LATE_HARNESS_ERROR_NOTE } from '@goondocks/myco-shared/run-text';
import { MAP_ACTION, MAP_UNCHANGED_ACTION } from '@goondocks/myco-shared/canopy';
import { MAX_REPOSITORY_HISTORY_DEPTH } from '@goondocks/myco-shared/repository';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { lit, memberHeadersFor, type ParityScenario } from '../harness.ts';
import { RUN_AUDIT } from '../../helpers/run-audit.ts';

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
    const leasedRun = async (label: string, pinnedCommit = commit) => {
      const token = `map-parity-${label}-${now}`.padEnd(43, 'x');
      const tokenId = `mt_map_${label}_${now}`;
      const runId = `map_${label}_${now}`;
      issued.push(tokenId);
      await target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,bytes_written,lineage_root,lineage_started_at)
        VALUES (${lit(tokenId)},'mem_harness','harness',${lit(await sha256Hex(token))},${now},${now + 3_600_000},0,${lit(tokenId)},${now})`);
      await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,dispatched_by,leased_by,lease_expires_at,run_context)
        VALUES (${lit(target.projectId)},${lit(runId)},'myco-agent','canopy-map','running',${now},${lit(tokenId)},${lit(workerId)},${now + LEASE_MS},
          ${lit(JSON.stringify({ checkout: { ...source, historyDepth: MAX_REPOSITORY_HISTORY_DEPTH } }))})`);
      const pinned = await post('/worker/repository', target.memberToken, { projectId: target.projectId, runId, ...source, commit: pinnedCommit });
      expect(pinned.pin).toEqual({ ...source, commit: pinnedCommit });
      return { token, runId };
    };
    const end = async (runId: string, extra: Record<string, unknown> = {}) => post('/worker/end', target.memberToken, { projectId: target.projectId, runId, status: 'completed', ...extra });

    try {
      expect((await owner(`${endpoint}/canopy-map`)).map).toBeNull();
      const first = await leasedRun('first');
      expect(await tool(first.token, 'myco_run_map', { op: 'get' })).toMatchObject({ commit, unchanged: false, map: null });
      const evidence = { path: 'src/main.ts', sha256: 'c'.repeat(64) };
      const artifact = { directories: [{ path: 'src', annotation: 'Source.', groundedIn: [evidence] }], domains: [
        { id: 'main', title: 'Main', files: [{ path: evidence.path, annotation: 'Starts the application.', groundedIn: [evidence] }] },
      ] };
      expect(await tool(first.token, 'myco_run_map', { op: 'write', artifact })).toMatchObject({ written: true, commit });
      await tool(first.token, 'myco_run', { op: 'report', audit: RUN_AUDIT, action: MAP_ACTION, summary: 'mapped' });
      const lateError = { status: 'failed', error: 'the harness stopped: error (harness_error)', harnessStop: { code: 'harness_error', detail: 'Provider disconnected; token: sk-test-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' } };
      expect(await end(first.runId, lateError)).toMatchObject({ ended: true, status: 'completed' });
      const detail = await owner(`${endpoint}/runs/${first.runId}`);
      expect(detail.run).toMatchObject({ status: 'completed', error: null, endedNote: LATE_HARNESS_ERROR_NOTE, harnessStop: { code: 'harness_error', detail: expect.stringContaining('Provider disconnected') } });
      expect(JSON.stringify(detail)).not.toContain('sk-test-');
      const work = await owner(`/api/work?project=${target.projectId}&since=${now - 1000}&until=${Date.now() + 10_000}`);
      expect(work.runs.find((run: { id: string }) => run.id === first.runId)).toMatchObject({ status: 'completed', failure: null });
      expect(await end(first.runId, lateError)).toMatchObject({ ended: false });
      const attention = await owner('/api/attention');
      expect(attention.items.filter((item: { kind: string; runId?: string }) => item.kind === 'outcome_failed' && item.runId === first.runId)).toEqual([]);
      expect((await target.sql(`SELECT status, lease_expires_at FROM agent_runs WHERE project_id=${lit(target.projectId)} AND id=${lit(first.runId)}`))[0]).toMatchObject({ status: 'completed', lease_expires_at: null });

      const stored = (await owner(`${endpoint}/canopy-map`)).map;
      expect(stored).toMatchObject({ repository: { ...source, commit }, artifact, sourceRunId: first.runId });

      const second = await leasedRun('second');
      expect(await tool(second.token, 'myco_run_map', { op: 'get' })).toMatchObject({ commit, unchanged: true, map: { revision: stored.revision } });
      await tool(second.token, 'myco_run', { op: 'report', audit: RUN_AUDIT, action: MAP_UNCHANGED_ACTION, summary: 'unchanged' });
      expect(await end(second.runId, { status: 'failed', error: 'the harness stopped: error (crashed; exit code 3; signal SIGTERM)' })).toMatchObject({ ended: true, status: 'completed' });
      expect((await owner(`${endpoint}/runs/${second.runId}`)).run).toMatchObject({ endedNote: LATE_HARNESS_ERROR_NOTE, harnessStop: { code: 'crashed', exitCode: 3, signal: 'SIGTERM' } });
      for (const label of ['missing-artifact', 'before-report']) {
        const failed = await leasedRun(label, 'b'.repeat(40));
        if (label === 'missing-artifact') await tool(failed.token, 'myco_run', { op: 'report', audit: RUN_AUDIT, action: MAP_ACTION, summary: 'mapped without writing' });
        expect(await end(failed.runId, lateError)).toMatchObject({ ended: true, status: 'failed' });
        const failedDetail = await owner(`${endpoint}/runs/${failed.runId}`);
        expect(failedDetail.run.status).toBe('failed');
        expect(failedDetail.run.endedNote).toBeUndefined();
        if (label === 'missing-artifact') expect(failedDetail.run.error).toContain('the run ended without its artifact');
        else {
          const late = await fetch(target.url + '/mcp', { method: 'POST', headers: memberHeadersFor(failed.token, target.projectId, { 'content-type': 'application/json' }), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_run', arguments: { op: 'report', action: MAP_ACTION, summary: 'too late', audit: RUN_AUDIT } } }) });
          expect(late.status).toBe(401);
        }
      }


      const read = await tool(target.memberToken, 'myco_cortex', { op: 'canopy_map' });
      expect(read).toMatchObject({ project_id: target.projectId, revision: stored.revision, repository: { ...source, commit } });
      expect(read.content).toContain('Map Provenance');
    } finally {
      await owner(`${endpoint}/repository`, 'DELETE', { revision: connected.repository.revision });
      for (const id of issued) await target.sql(`UPDATE member_credentials SET revoked_at=${Date.now()} WHERE id=${lit(id)} AND revoked_at IS NULL`);
    }
  },
};
