import { strictName, strictRunId } from '@goondocks/myco-shared/run-text';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import worker from '@myco-server-worker/index.js';
import { memberPost, sqliteEnv } from './fixtures.js';
import { OWNER_ENV } from './owner.js';

/** A dispatch credential per run for HTTP field and lifecycle contract tests. */
export async function runRouteFixture(agentId: string) {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const now = Date.now();
  await ensureMember(fixture.db, HARNESS_MEMBER_ID, now, 'member', 'harness');
  const token = await issueMemberToken(fixture.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, now);
  fixture.sqlite.run("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES(?,'a','built-in',1,?)", [agentId, now]);
  fixture.sqlite.run("INSERT OR IGNORE INTO project_capabilities(project_id,capability,enabled,updated_at,updated_by) VALUES('proj_1','cortex',1,?,'test')", [now]);
  const tokens = new Map<string, typeof token>();
  const post = async (path: string, body: Record<string, unknown>, projectId = 'proj_1'): Promise<Record<string, unknown>> => {
    const id = String(path === '/runs/claim' ? body.id : body.runId ?? body.excludeRunId ?? 'r1');
    const key = `${projectId}:${id}`;
    if (path === '/runs/claim' && !tokens.has(key) && strictRunId(id) !== null && typeof body.task === 'string'
      && (body.capability !== undefined || body.captureDriven === true)) {
      const credential = tokens.size === 0 ? token : await issueMemberToken(fixture.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, Date.now());
      tokens.set(key, credential);
      await recordDispatch(fixture.db, { projectId }, { id, agentId, task: strictName(body.task) ?? 'digest', provider: null, model: null,
        runContext: '{}', dispatchedBy: credential.tokenId, startedAt: Date.now() });
    }
    return await (await worker.fetch(memberPost((tokens.get(key) ?? token).token, body, path, { 'x-myco-project': projectId }), env)).json() as Record<string, unknown>;
  };
  return { ...fixture, env, token, post };
}
