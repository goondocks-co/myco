import { expect } from 'bun:test';
import { A, B } from '../../myco-server/helpers/github-fake.ts';
import { event, owner, pick, type RouteTarget, type SeedTarget } from './requests.ts';

/** The session release tracking classified, by the id its member captured. */
export interface ReleaseSeed { sessionId: string }

/**
 * Release tracking the owner turned on, a session whose start and end commits its member captured, and the check the
 * owner asked for, answered by a modelled GitHub: the end commit is in a production tag, so the session reads released.
 */
export async function seedRelease(target: SeedTarget, stamp: number): Promise<ReleaseSeed> {
  const path = `/api/projects/${target.projectId}/release-provenance`;
  const saved = await owner(target, path, { method: 'PUT', body: JSON.stringify({
    revision: null, enabled: true, githubRepo: 'o/r', productionRefs: ['refs/tags/a/v*'], integrationRefs: ['origin/main'],
    packageMap: [], includeUnknown: true, maxLookups: 20, credential: null,
  }) });
  expect(saved.status).toBe(200);
  const sessionId = `upgrade-release-${stamp}`;
  await event(target, sessionId, 'session.start', { agent: 'claude-code', branch: 'release', headSha: B, startedAt: stamp + 50 }, stamp + 50);
  await event(target, sessionId, 'session.end', { endedAt: stamp + 51, headSha: A, dirty: false }, stamp + 51);
  expect((await owner(target, `${path}/check`, { method: 'POST' })).status).toBe(200);
  await target.checkRelease();
  const commits = await owner(target, `/api/projects/${target.projectId}/sessions/${sessionId}/commits`);
  expect(commits.body.release).toMatchObject({ state: 'released', basisRef: 'refs/tags/a/v1.2.0' });
  return { sessionId };
}

/** What the owner reads of release tracking and of the classified session's commits. */
export async function observeRelease(target: RouteTarget, seed: ReleaseSeed): Promise<Record<string, unknown>> {
  const tracking = await owner(target, `/api/projects/${target.projectId}/release-provenance`);
  const commits = await owner(target, `/api/projects/${target.projectId}/sessions/${seed.sessionId}/commits`);
  return {
    tracking: [tracking.status, pick(tracking.body.releaseProvenance, ['enabled', 'githubRepo', 'productionRefs', 'integrationRefs', 'packageMap', 'revision'])],
    commits: [commits.status, commits.body],
  };
}
