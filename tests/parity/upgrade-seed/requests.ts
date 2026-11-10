import { expect } from 'bun:test';
import { PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { expectPersisted, type ParityTarget } from '../harness.ts';
import { revisionHeaders } from '../settings-revision.ts';

/** What reading a target takes: its routes, its credentials and its store. */
export type RouteTarget = Pick<ParityTarget, 'url' | 'projectId' | 'deploymentId' | 'sql' | 'ownerHeaders' | 'memberHeaders'>;

/** What seeding a target takes besides: a way to embed what its members saved. */
export type SeedTarget = RouteTarget & { primeEmbedding(projectId: string): Promise<void> };

/** An answer's status and body. */
export interface Answer { status: number; body: any }

/** A captured event over the seed member's credential, as the hooks send it. */
export async function event(target: RouteTarget, sessionId: string, kind: string, payload: Record<string, unknown>, createdAt: number, headers = target.memberHeaders()): Promise<void> {
  await expectPersisted(await fetch(`${target.url}/events`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
  }), kind);
}

/** One MCP tool call over the seed member's credential, answering its structured result. */
export async function mcp(target: RouteTarget, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${target.url}/mcp`, {
    method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: { structuredContent: { result: Record<string, unknown> } } }).result.structuredContent.result;
}

/** A dashboard request as the owner's browser sends it. */
export async function owner(target: RouteTarget, path: string, init: RequestInit = {}): Promise<Answer> {
  const res = await fetch(`${target.url}${path}`, { ...init, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  return { status: res.status, body: await res.json() };
}

/** A settings write from the dashboard, carrying the revision the dashboard read, as every settings write must. */
export async function setting(target: RouteTarget, path: string, body: Record<string, unknown>): Promise<Answer> {
  return owner(target, path, { method: 'PUT', headers: await revisionHeaders(target, path, body), body: JSON.stringify(body) });
}

/** A POST as a machine or runner client sends it: its bearer when it holds one, the protocol header and a source address. */
export async function client(target: RouteTarget, path: string, body: unknown, bearer?: string): Promise<Answer> {
  const res = await fetch(`${target.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}`, [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) }) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** The named fields of an answer, so two reads compare what a user reads and not what the read path adds beside it. */
export const pick = (value: any, keys: readonly string[]): Record<string, unknown> => Object.fromEntries(keys.map((key) => [key, value?.[key]]));
