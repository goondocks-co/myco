import { expect } from 'bun:test';
import { PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import type { ParityTarget } from '../harness.ts';
import { owner } from '../clients/requests.ts';
import { revisionHeaders } from '../settings-revision.ts';

/** What reading a target takes: its routes, its credentials and its store. */
export type RouteTarget = Pick<ParityTarget, 'url' | 'projectId' | 'deploymentId' | 'sql' | 'ownerHeaders' | 'memberHeaders'>;

/**
 * What seeding a target takes besides: a way to embed what its members saved, and to run the release check its owner
 * requested against a modelled GitHub.
 */
export type SeedTarget = RouteTarget & { primeEmbedding(projectId: string): Promise<void>; checkRelease(): Promise<void> };

/** An answer's status and body. */
export interface Answer { status: number; body: any }

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
