/**
 * Work that outlives its answer. Each target maps `afterResponse` onto what it
 * has: a deferral handed in with the request, or a tracked promise the
 * self-hosted env waits for before it closes.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { serverEnvFromBunConfig } from '@myco-server-worker/platform/bun/env.js';
import { createBunHandler } from '@myco-server-worker/entry/bun.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { envelope, memberPost, recordingDeferred, sqliteEnv, uuid } from './helpers/fixtures.js';

const later = (): { promise: Promise<void>; done: () => void } => {
  let done = () => {};
  const promise = new Promise<void>((resolve) => { done = resolve; });
  return { promise, done };
};

describe('afterResponse', () => {
  it('hands the work to the deferral the request carries, and starts nothing when none is given', async () => {
    const e = sqliteEnv();
    const deferred = recordingDeferred();
    const work = later();
    serverEnvFromBindings(e.env as never, deferred).afterResponse(() => work.promise);
    expect(deferred.pending).toEqual([work.promise]);

    let started = false;
    serverEnvFromBindings(e.env as never).afterResponse(() => { started = true; return Promise.resolve(); });
    expect(started).toBe(false);
    expect(deferred.pending).toHaveLength(1);
  });

  it('on the self-hosted target, settle() waits for every deferred piece of work, a rejecting one included', async () => {
    const env = serverEnvFromBunConfig({ sqlite: new Database(':memory:'), blobDir: mkdtempSync(join(tmpdir(), 'myco-blobs-')) });
    const slow = later();
    let finished = false;
    env.afterResponse(() => slow.promise.then(() => { finished = true; }));
    env.afterResponse(() => Promise.reject(new Error('the work reports its own failure')));
    let settled = false;
    const settling = env.settle().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    slow.done();
    await settling;
    expect({ settled, finished }).toEqual({ settled: true, finished: true });
    await env.settle();
  });

  it('on the self-hosted target, close() lands the work an answered request left behind before the store closes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'myco-close-'));
    const databasePath = join(root, 'myco.sqlite');
    const sqlite = new Database(databasePath);
    sqlite.exec('PRAGMA foreign_keys = ON');
    for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
    sqlite.query(`INSERT INTO members (id,label,created_at,revoked_at) VALUES ('mem_machine_1','machine_1',0,NULL)`).run();
    for (const [leaf, value] of [['agent.provider.type', 'openai-compatible'], ['agent.provider.model', 'm'], ['agent.provider.base_url', 'http://titles.internal/v1']]) {
      sqlite.query(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, 1, 'mem_1')`).run(leaf, JSON.stringify(value));
    }
    const { token } = await issueMemberToken(sqliteRelationalStore(sqlite), { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    sqlite.close();

    const originalFetch = globalThis.fetch;
    const answered = later();
    globalThis.fetch = (async () => { await answered.promise; return Response.json({ choices: [{ message: { content: '{"title": "Landed before close", "summary": "It did."}' } }] }); }) as unknown as typeof fetch;
    try {
      const handler = await createBunHandler({ databasePath, blobDir: join(root, 'blobs'), header: 'x-forwarded-for' } as never);
      const post = (over: Record<string, unknown>) => handler.fetch(memberPost(token, envelope(over), '/events', { 'x-forwarded-for': '1.2.3.4' }));
      expect((await post({ eventId: uuid(1), kind: 'session.start', payload: { agent: 'a', startedAt: 1_000 } })).status).toBe(200);
      expect((await post({ eventId: uuid(2), payload: { promptId: uuid(20), text: 'hello there', origin: 'user' } })).status).toBe(200);
      expect((await post({ eventId: uuid(3), kind: 'session.end', createdAt: 5_000, payload: { endedAt: 5_000 } })).status).toBe(200);
      const closing = handler.close();
      let closed = false;
      void closing.then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
      answered.done();
      await closing;
    } finally {
      globalThis.fetch = originalFetch;
    }
    const after = new Database(databasePath, { readonly: true });
    try {
      expect(after.query(`SELECT title FROM sessions WHERE session_id = 'sess_1'`).get()).toEqual({ title: 'Landed before close' });
    } finally { after.close(); }
  });
});

