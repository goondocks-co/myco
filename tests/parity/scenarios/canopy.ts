import { expect } from 'bun:test';
import { LATE_HARNESS_ERROR_NOTE } from '@goondocks/myco-shared/run-text';
import { MAP_ACTION, MAP_UNCHANGED_ACTION } from '@goondocks/myco-shared/canopy';
import { memberHeadersFor, type ParityScenario } from '../harness.ts';
import { RUN_AUDIT } from '../../helpers/run-audit.ts';
import { allowWorkerClaims, putCapability } from '../clients/requests.ts';
import { dispatch, takeRun } from '../clients/runs.ts';

/**
 * A map run on the worker path, on both targets: the worker's repository step
 * pins the commit and the map input together, the run writes its map over its
 * own credential, the worker's end is judged against the stored row, a second
 * pass over the same commit closes unchanged, and a member reads the map.
 */
export const canopy: ParityScenario = {
  name: 'canopy: a worker map run pinned to its commit, closed on its map, and read over MCP',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    const now = Date.now();
    await allowWorkerClaims(target);
    expect((await putCapability(target, 'canopy', true)).status).toBe(200);
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
    const claimed = new Map<string, { attemptId: string }>();
    const leasedRun = async (pinnedCommit = commit) => {
      const run = await takeRun(target, (await dispatch(target, 'canopy-map')).runId);
      claimed.set(run.id, run);
      const pinned = await post('/worker/repository', target.memberToken, { projectId: target.projectId, runId: run.id, attemptId: run.attemptId, ...source, commit: pinnedCommit });
      expect(pinned.pin).toEqual({ ...source, commit: pinnedCommit });
      return { token: run.runToken, runId: run.id };
    };
    const end = async (runId: string, extra: Record<string, unknown> = {}) => post('/worker/end', target.memberToken, { projectId: target.projectId, runId, attemptId: claimed.get(runId)!.attemptId, status: 'completed', ...extra });

    try {
      expect((await owner(`${endpoint}/canopy-map`)).map).toBeNull();
      const first = await leasedRun();
      expect(await tool(first.token, 'myco_run_map', { op: 'get' })).toMatchObject({ commit, unchanged: false, map: null });
      const evidence = { path: 'src/main.ts', sha256: 'c'.repeat(64) };
      const artifact = { directories: [{ path: 'src', annotation: 'Source.', groundedIn: [evidence] }], domains: [
        { id: 'main', title: 'Main', files: [{ path: evidence.path, annotation: 'Starts the application.', groundedIn: [evidence] }] },
      ] };
      expect(await tool(first.token, 'myco_run_map', { op: 'write', artifact })).toMatchObject({ written: true, commit });
      await tool(first.token, 'myco_run', { op: 'report', audit: RUN_AUDIT, action: MAP_ACTION, summary: 'mapped' });
      const lateError = { status: 'failed', error: 'the harness stopped: error (harness_error)', harnessStop: { code: 'harness_error', detail: 'hello hunter22 world /Users/chris/Repos/secret-project/notes.md', fields: { subtype: 'error_during_execution', terminal_reason: 'api_error', stop_reason: 'tool_use', private: 'hunter22' } } };
      expect(await end(first.runId, lateError)).toMatchObject({ ended: true, status: 'completed' });
      const detail = await owner(`${endpoint}/runs/${first.runId}`);
      expect(detail.run).toMatchObject({ status: 'completed', error: null, endedNote: LATE_HARNESS_ERROR_NOTE, harnessStop: { code: 'harness_error', fields: { subtype: 'error_during_execution', terminal_reason: 'api_error', stop_reason: 'tool_use' } } });
      for (const privateText of ['hunter22', '/Users/chris', 'private']) expect(JSON.stringify(detail.run.harnessStop)).not.toContain(privateText);
      const work = await owner(`/api/work?project=${target.projectId}&since=${now - 1000}&until=${Date.now() + 10_000}`);
      expect(work.timeline.find((run: { id: string }) => run.id === first.runId)).toMatchObject({ status: 'completed', failure: null });
      expect(await end(first.runId, lateError)).toMatchObject({ ended: false });
      const attention = await owner('/api/attention');
      expect(attention.items.filter((item: { kind: string; runId?: string }) => item.kind === 'outcome_failed' && item.runId === first.runId)).toEqual([]);
      expect(detail.run).toMatchObject({ status: 'completed', leaseExpiresAt: null });

      const stored = (await owner(`${endpoint}/canopy-map`)).map;
      expect(stored).toMatchObject({ repository: { ...source, commit }, artifact, sourceRunId: first.runId });

      const second = await leasedRun();
      expect(await tool(second.token, 'myco_run_map', { op: 'get' })).toMatchObject({ commit, unchanged: true, map: { revision: stored.revision } });
      await tool(second.token, 'myco_run', { op: 'report', audit: RUN_AUDIT, action: MAP_UNCHANGED_ACTION, summary: 'unchanged' });
      expect(await end(second.runId, { status: 'failed', error: 'the harness stopped: error (crashed; exit code 3; signal SIGTERM)' })).toMatchObject({ ended: true, status: 'completed' });
      expect((await owner(`${endpoint}/runs/${second.runId}`)).run).toMatchObject({ endedNote: LATE_HARNESS_ERROR_NOTE, harnessStop: { code: 'crashed', exitCode: 3, signal: 'SIGTERM' } });
      for (const label of ['missing-artifact', 'before-report']) {
        const failed = await leasedRun('b'.repeat(40));
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
    }
  },
};
