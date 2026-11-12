import { expect } from 'bun:test';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { offeredHarness } from '../../myco-server/helpers/offered-harness.ts';
import { expectPersisted, memberHeadersFor, type ParityTarget } from '../harness.ts';
import { revisionHeaders } from '../settings-revision.ts';

/** What a parity scenario needs to call the Deployment the way a client does. */
export type RouteTarget = Pick<ParityTarget, 'url' | 'projectId' | 'ownerHeaders' | 'memberHeaders'>;

/** An answer's status and body. */
export interface Answer { status: number; body: any }

/** A run a worker claimed, with the credential the harness child uses. */
export interface ClaimedRun {
  id: string;
  task: string;
  attemptId: string;
  runToken: string;
  instruction?: string | null;
}

const jsonHeaders = { 'content-type': 'application/json' };

/** A dashboard request as the owner's browser sends it. */
export async function owner<T = any>(target: RouteTarget, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${target.url}${path}`, {
    ...init,
    headers: { ...target.ownerHeaders(), origin: target.url, ...jsonHeaders, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

/** A captured event over the member's credential, as the hooks send it. */
export async function event(target: RouteTarget, sessionId: string, kind: string, payload: Record<string, unknown>, createdAt = Date.now(), projectId = target.projectId): Promise<void> {
  await expectPersisted(await fetch(`${target.url}/events`, {
    method: 'POST',
    headers: { ...target.memberHeaders({ 'x-myco-project': projectId }), ...jsonHeaders },
    body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
  }), kind);
}

/** One MCP tool call, answering its structured result. */
export async function mcp(target: RouteTarget, name: string, args: Record<string, unknown>, projectId = target.projectId): Promise<Record<string, unknown>> {
  const response = await fetch(`${target.url}/mcp`, {
    method: 'POST',
    headers: { ...target.memberHeaders({ 'x-myco-project': projectId }), ...jsonHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project: projectId, ...args } } }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { error?: unknown; result?: { isError?: boolean; structuredContent?: { result: Record<string, unknown> } } };
  expect(body.error).toBeUndefined();
  expect(body.result?.isError).not.toBe(true);
  return body.result?.structuredContent?.result ?? {};
}

/** A settings write carrying the revision the dashboard just read. */
export async function putSetting(target: RouteTarget, leaf: string, value: unknown): Promise<Answer> {
  const path = `/api/settings/${leaf}`;
  return owner(target, path, { method: 'PUT', headers: await revisionHeaders(target, path), body: JSON.stringify({ value }) });
}

/** Clear one configured leaf so its built-in value applies, against the revision just read. */
export async function resetSetting(target: RouteTarget, leaf: string): Promise<Answer> {
  const path = `/api/settings/${leaf}`;
  return owner(target, path, { method: 'DELETE', headers: await revisionHeaders(target, path) });
}

/** Admit or withdraw one Project capability, against the revision the editor just read. */
export async function putCapability(target: RouteTarget, capability: string, enabled: boolean, projectId = target.projectId): Promise<Answer> {
  const path = `/api/projects/${projectId}/capabilities/${capability}`;
  return owner(target, path, { method: 'PUT', headers: await revisionHeaders(target, path), body: JSON.stringify({ enabled }) });
}

/** Create a Project the owner names. The id is one the client may send. */
export async function createProject(target: RouteTarget, projectId: string, name: string): Promise<Answer> {
  return owner(target, '/api/projects', { method: 'POST', body: JSON.stringify({ projectId, name }) });
}

/** Archive a Project, then restore it. The restore runs even when the body throws. */
export async function archived(target: RouteTarget, projectId: string, body: () => Promise<void>): Promise<void> {
  const archivedAt = await owner(target, `/api/projects/${projectId}/archive`, { method: 'POST' });
  expect(archivedAt.status).toBe(200);
  try {
    await body();
  } finally {
    const restored = await owner(target, `/api/projects/${projectId}/unarchive`, { method: 'POST' });
    expect(restored.status).toBe(200);
  }
}

/** Run the server's wake once. */
export async function wake(target: RouteTarget): Promise<void> {
  const response = await owner(target, '/api/wake', { method: 'POST', body: '{}' });
  expect(response.status).toBe(200);
}

/** Read `load` until `ready` or the wake budget is spent, waking between reads. */
export async function untilPublished<T>(target: RouteTarget, load: () => Promise<T>, ready: (value: T) => boolean, wakes = 8): Promise<T> {
  let value = await load();
  for (let attempt = 0; attempt < wakes && !ready(value); attempt += 1) {
    await wake(target);
    value = await load();
  }
  return value;
}

/** The session detail a reader opens. */
export async function sessionDetail(target: RouteTarget, sessionId: string, projectId = target.projectId): Promise<Answer> {
  return owner(target, `/api/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}`);
}

/** Let a member claim a run: a harness sign-in and a daily budget the claim can draw on. */
export async function allowWorkerClaims(target: RouteTarget): Promise<void> {
  for (const [leaf, value] of [
    ['agent.harnesses.claude-code.credential', 'worker-login'],
    ['agent.budget.daily_usd', 1],
  ] as const) {
    const saved = await putSetting(target, leaf, value);
    expect({ leaf, status: saved.status, body: saved.body }).toMatchObject({ status: 200 });
  }
}

/** Take the next run this member can run. */
export async function claimRun(target: RouteTarget): Promise<{ claimed: boolean; reason?: string; run?: ClaimedRun }> {
  const response = await fetch(`${target.url}/worker/claim`, {
    method: 'POST',
    headers: { ...target.memberHeaders(), ...jsonHeaders },
    body: JSON.stringify({ harnesses: [offeredHarness('claude-code')], capabilities: [...WORKER_CAPABILITIES] }),
  });
  expect(response.status).toBe(200);
  return await response.json() as { claimed: boolean; reason?: string; run?: ClaimedRun };
}

/** A run tool call over the credential the claim issued. */
export async function runTool<T = Record<string, unknown>>(target: RouteTarget, run: ClaimedRun, name: string, input: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${target.url}/mcp`, {
    method: 'POST',
    headers: { ...memberHeadersFor(run.runToken, target.projectId), ...jsonHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project: target.projectId, ...input } } }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { error?: unknown; result?: { isError?: boolean; structuredContent?: { result: T } } };
  expect(body.error).toBeUndefined();
  expect(body.result?.isError).not.toBe(true);
  return body.result!.structuredContent!.result;
}

/** End a run this member's worker holds. */
export async function endRun(target: RouteTarget, run: ClaimedRun, costUsd = 0): Promise<{ ended: boolean; status?: string; reason?: string }> {
  const response = await fetch(`${target.url}/worker/end`, {
    method: 'POST',
    headers: { ...target.memberHeaders(), ...jsonHeaders },
    body: JSON.stringify({
      projectId: target.projectId, runId: run.id, attemptId: run.attemptId, status: 'completed',
      usage: { inputTokens: null, outputTokens: null, costUsd },
    }),
  });
  expect(response.status).toBe(200);
  return await response.json() as { ended: boolean; status?: string; reason?: string };
}
