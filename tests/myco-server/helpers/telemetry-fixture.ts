import type { Database } from 'bun:sqlite';
import { expect } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { TELEMETRY_RETENTION_MS } from '@myco-server-worker/core/telemetry-policy.js';
import { seedCredential } from './d1.js';
import { sqliteEnv, envelope, noOutboundFetch, uuid } from './fixtures.js';
import { OWNER_ENV, ownerCookie } from './owner.js';
const NOW = 1_800_000_000_000;
export async function telemetryFixture(sqlite?: Database) {
  const e = sqliteEnv({ sqlite });
  Object.assign(e.env, OWNER_ENV);
  const env = e.serverEnv;
  let now = NOW;
  const server = createServer({ now: () => now, sourceOf: () => 'loopback', fetchImpl: noOutboundFetch });
  const owner = async (path: string, body?: unknown) =>
    server.handleRequest(
      new Request(`https://s${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          cookie: await ownerCookie(e.db, now),
          origin: 'https://s',
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  const issued = await owner('/api/telemetry/keys', { label: 'test sender' });
  expect(issued.status).toBe(201);
  const { key, id } = (await issued.json()) as { key: string; id: string };
  const send = (body: unknown, path = '/v1/traces', headers: Record<string, string> = {}) =>
    server.handleRequest(
      new Request(`https://s${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      env,
    );
  seedCredential(e.sqlite, { expiresAt: NOW + TELEMETRY_RETENTION_MS * 2 });
  let event = 1;
  const capture = async (
    sessionId: string,
    kind: 'prompt' | 'session.start',
    payload: Record<string, unknown>,
    projectId = 'proj_1',
  ) => {
    const result = await ingestEvent(
      e.db,
      { projectId, machineId: 'machine_1', tokenId: 'mt_1', bodyBytes: 100, now },
      envelope({
        eventId: uuid(event++),
        sessionId,
        kind,
        createdAt: now,
        payload,
      }),
    );
    expect(result.persisted).toBe(true);
  };
  const start = (sessionId: string, projectId = 'proj_1', payload: Record<string, unknown> = {}) =>
    capture(
      sessionId,
      'session.start',
      { agent: 'codex', startedAt: now, branch: 'feature', ...payload },
      projectId,
    );
  return {
    e,
    env,
    server,
    owner,
    key,
    id,
    send,
    start,
    capture,
    advance: (at: number) => {
      now = at;
    },
  };
}
