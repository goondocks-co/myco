import { expect } from 'bun:test';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { offeredHarness } from '../../myco-server/helpers/offered-harness.ts';
import { expectPersisted, memberHeadersFor, type ParityTarget } from '../harness.ts';
import { revisionHeaders } from '../settings-revision.ts';

export type RouteTarget = Pick<ParityTarget, 'url' | 'projectId' | 'ownerHeaders' | 'memberHeaders'>;
export interface Answer { status: number; body: any }
export interface ClaimedRun { id: string; task: string; attemptId: string; runToken: string; instruction?: string | null }
const json = { 'content-type': 'application/json' };

export async function owner<T = any>(target: RouteTarget, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${target.url}${path}`, { ...init, headers: { ...target.ownerHeaders(), origin: target.url, ...json, ...(init.headers ?? {}) } });
  const text = await response.text(); return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}
export async function event(target: RouteTarget, sessionId: string, kind: string, payload: Record<string, unknown>, createdAt = Date.now(), projectId = target.projectId, extra: { channel?: string; producer?: { adapter: string; version: string } } = {}): Promise<void> {
  await expectPersisted(await fetch(`${target.url}/events`, { method: 'POST', headers: { ...target.memberHeaders({ 'x-myco-project': projectId }), ...json }, body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt, channel: extra.channel ?? 'cli', producer: extra.producer ?? { adapter: 'parity', version: '1' }, payload }) }), kind);
}
async function postJson<T>(target: RouteTarget, path: string, body: unknown, headers: Record<string, string>): Promise<T> {
  const response = await fetch(`${target.url}${path}`, { method: 'POST', headers: { ...headers, ...json }, body: JSON.stringify(body) });
  expect(response.status).toBe(200); return await response.json() as T;
}
async function toolCall<T>(headers: Record<string, string>, target: RouteTarget, name: string, args: Record<string, unknown>, projectId: string): Promise<T> {
  const body = await postJson<{ error?: unknown; result?: { isError?: boolean; structuredContent?: { result: T } } }>(target, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project: projectId, ...args } } }, headers);
  expect(body.error).toBeUndefined(); expect(body.result?.isError).not.toBe(true); return body.result!.structuredContent!.result;
}
export const mcp = (target: RouteTarget, name: string, args: Record<string, unknown>, projectId = target.projectId): Promise<Record<string, unknown>> => toolCall(target.memberHeaders({ 'x-myco-project': projectId }), target, name, args, projectId);
export const runTool = <T = Record<string, unknown>>(target: RouteTarget, run: ClaimedRun, name: string, input: Record<string, unknown>) => toolCall<T>(memberHeadersFor(run.runToken, target.projectId), target, name, input, target.projectId);
const revisioned = async (target: RouteTarget, path: string, method: 'PUT' | 'DELETE', body?: unknown) => owner(target, path, { method, headers: await revisionHeaders(target, path), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const putSetting = (target: RouteTarget, leaf: string, value: unknown) => revisioned(target, `/api/settings/${leaf}`, 'PUT', { value });
export const resetSetting = (target: RouteTarget, leaf: string) => revisioned(target, `/api/settings/${leaf}`, 'DELETE');
export const putCapability = (target: RouteTarget, capability: string, enabled: boolean, projectId = target.projectId) => revisioned(target, `/api/projects/${projectId}/capabilities/${capability}`, 'PUT', { enabled });
export const createProject = (target: RouteTarget, projectId: string, name: string) => owner(target, '/api/projects', { method: 'POST', body: JSON.stringify({ projectId, name }) });
export async function archived(target: RouteTarget, projectId: string, body: () => Promise<void>): Promise<void> {
  expect((await owner(target, `/api/projects/${projectId}/archive`, { method: 'POST' })).status).toBe(200); try { await body(); } finally { expect((await owner(target, `/api/projects/${projectId}/unarchive`, { method: 'POST' })).status).toBe(200); }
}
export const wake = async (target: RouteTarget): Promise<void> => { expect((await owner(target, '/api/wake', { method: 'POST', body: '{}' })).status).toBe(200); };
export async function untilPublished<T>(target: RouteTarget, load: () => Promise<T>, ready: (value: T) => boolean, wakes = 8): Promise<T> {
  let value = await load(); for (let attempt = 0; attempt < wakes && !ready(value); attempt += 1) { await wake(target); value = await load(); } if (ready(value)) return value; throw new Error(`not ready after ${wakes} wakes: ${JSON.stringify(value).slice(0, 800)}`);
}
export const sessionDetail = (target: RouteTarget, sessionId: string, projectId = target.projectId): Promise<Answer> => owner(target, `/api/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}`);
export async function allowWorkerClaims(target: RouteTarget): Promise<void> {
  for (const [leaf, value] of [['agent.harnesses.claude-code.credential', 'worker-login'], ['agent.budget.daily_usd', 1]] as const) expect((await putSetting(target, leaf, value)).status).toBe(200);
}
export const claimRun = (target: RouteTarget) => postJson<{ claimed: boolean; reason?: string; run?: ClaimedRun }>(target, '/worker/claim', { harnesses: [offeredHarness('claude-code')], capabilities: [...WORKER_CAPABILITIES] }, target.memberHeaders());
export const endRun = (target: RouteTarget, run: ClaimedRun, costUsd = 0) => postJson<{ ended: boolean; status?: string; reason?: string }>(target, '/worker/end', { projectId: target.projectId, runId: run.id, attemptId: run.attemptId, status: 'completed', usage: { inputTokens: null, outputTokens: null, costUsd } }, target.memberHeaders());
