import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { offeredHarness } from '../../myco-server/helpers/offered-harness.ts';
import { RUN_AUDIT } from '../../helpers/run-audit.ts';
import { memberHeadersFor, SESSION_SECRET, type ParityTarget } from '../harness.ts';
import { event, owner, runTool, untilPublished, type ClaimedRun, type RouteTarget } from './requests.ts';

export async function worker(target: RouteTarget, path: string, body: unknown): Promise<any> {
  const response = await fetch(`${target.url}/worker/${path}`, { method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
  expect(response.status).toBe(200); return response.json();
}
export async function dispatch(target: RouteTarget, task: string, options: Record<string, unknown> = {}): Promise<{ runId: string; queued: boolean; heldBy: string }> {
  const answer = await owner(target, '/api/harness/dispatch', { method: 'POST', body: JSON.stringify({ task, projectId: target.projectId, ...options }) });
  expect(answer.status).toBe(200); expect(typeof answer.body.runId).toBe('string'); return answer.body;
}
export async function runDetail(target: RouteTarget, id: string): Promise<any> {
  const answer = await owner(target, `/api/projects/${target.projectId}/runs/${id}`);
  expect(answer.status).toBe(200); return answer.body;
}
export async function runList(target: RouteTarget, query = ''): Promise<any[]> {
  const rows: any[] = []; let cursor: string | null = null;
  for (let page = 0; page < 30; page += 1) {
    const answer: { status: number; body: { rows: any[]; cursor?: string | null } } = await owner(target, `/api/projects/${target.projectId}/runs?limit=100${query === '' ? '' : `&${query}`}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
    expect(answer.status).toBe(200); rows.push(...answer.body.rows);
    if ((cursor = answer.body.cursor ?? null) === null) return rows;
  }
  throw new Error('the run list did not end');
}
export async function takeRun(target: RouteTarget, expectedId?: string): Promise<ClaimedRun> {
  const answer = await worker(target, 'claim', { harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES });
  expect({ claimed: answer.claimed, reason: answer.reason }).toMatchObject({ claimed: true });
  if (expectedId !== undefined) expect(answer.run.id).toBe(expectedId);
  return answer.run;
}
export async function failRun(target: RouteTarget, run: ClaimedRun, extra: Record<string, unknown> = {}): Promise<any> {
  return worker(target, 'end', { projectId: target.projectId, runId: run.id, attemptId: run.attemptId, status: 'failed', error: 'the worker stopped before completing the task', ...extra });
}
export async function cancelRun(target: RouteTarget, id: string): Promise<void> {
  expect((await owner(target, `/api/projects/${target.projectId}/runs/${id}/cancel`, { method: 'POST' })).status).toBe(200);
}
export async function repository(target: RouteTarget, source = { url: 'https://example.test/repo.git', branch: 'main' }): Promise<void> {
  expect((await owner(target, `/api/projects/${target.projectId}/repository`, { method: 'PUT', body: JSON.stringify({ ...source, revision: null }) })).status).toBe(200);
}
export async function captureSession(target: RouteTarget, id: string, text: string, options: { ended?: boolean; at?: number; channel?: string } = {}): Promise<void> {
  const at = options.at ?? Date.now(), extra = { channel: options.channel ?? 'cli' };
  await event(target, id, 'session.start', { agent: 'claude-code', startedAt: at }, at, target.projectId, extra);
  await event(target, id, 'prompt', { promptId: crypto.randomUUID(), text, origin: 'user' }, at, target.projectId, extra);
  if (options.ended) await event(target, id, 'session.end', { endedAt: at }, at, target.projectId, extra);
  await publishedSession(target, id);
}
export async function publishedSession(target: RouteTarget, id: string, minimumTurns = 1): Promise<void> {
  await untilPublished(target, () => owner(target, `/api/projects/${target.projectId}/sessions/${encodeURIComponent(id)}/turns`), answer => answer.status === 200 && answer.body.rows?.length >= minimumTurns);
}
export async function askTitle(target: RouteTarget, sessionId: string): Promise<string> {
  const answer = await owner(target, `/api/projects/${target.projectId}/sessions/${encodeURIComponent(sessionId)}/title`, { method: 'POST' });
  expect(answer.status).toBe(200); expect(answer.body.outcome).toMatch(/^(queued|dispatched)$/); expect(typeof answer.body.runId).toBe('string'); return answer.body.runId;
}
export async function report(target: RouteTarget, run: ClaimedRun, action: string, summary: string): Promise<void> {
  await runTool(target, run, 'myco_run', { op: 'report', action, summary, audit: RUN_AUDIT });
}
export async function linkedMember(target: ParityTarget, sub: string): Promise<{ memberId: string; token: string; headers: Record<string, string> }> {
  const invite = await owner(target, '/api/enrollment', { method: 'POST', body: JSON.stringify({ role: 'member' }) });
  expect(invite.status).toBe(201);
  const joinedResponse = await fetch(`${target.url}/members/join`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' }, body: JSON.stringify({ key: invite.body.key, machineId: `member-${crypto.randomUUID()}` }) });
  expect(joinedResponse.status).toBe(200); const joined = await joinedResponse.json() as { joined: boolean; memberId: string; token: string }; expect(joined.joined).toBe(true);
  const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: target.deploymentId, sub, login: 'member', iat: Date.now(), exp: Date.now() + 3_600_000 })}`;
  const headers = { cookie, 'cf-connecting-ip': '1.2.3.4', origin: target.url, 'content-type': 'application/json' };
  const link = await owner(target, `/api/members/${joined.memberId}/link-github`, { method: 'POST' }); expect(link.status).toBe(201);
  const confirmed = await fetch(`${target.url}/auth/link`, { method: 'POST', headers, body: JSON.stringify({ key: link.body.key, confirm: true }) }); expect(confirmed.status).toBe(200);
  return { ...joined, headers };
}
export function asMember(target: RouteTarget, token: string): RouteTarget {
  return { ...target, memberHeaders: (extra = {}) => memberHeadersFor(token, target.projectId, extra) };
}
