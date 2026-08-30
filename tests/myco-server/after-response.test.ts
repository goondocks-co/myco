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
import { recordingDeferred, sqliteEnv } from './helpers/fixtures.js';

const later = (): { promise: Promise<void>; done: () => void } => {
  let done = () => {};
  const promise = new Promise<void>((resolve) => { done = resolve; });
  return { promise, done };
};

describe('afterResponse', () => {
  it('hands the work to the deferral the request carries, and runs it detached when none is given', async () => {
    const e = sqliteEnv();
    const deferred = recordingDeferred();
    const work = later();
    serverEnvFromBindings(e.env as never, deferred).afterResponse(work.promise);
    expect(deferred.pending).toEqual([work.promise]);

    let ran = false;
    const detached = Promise.resolve().then(() => { ran = true; });
    serverEnvFromBindings(e.env as never).afterResponse(detached);
    await detached;
    expect(ran).toBe(true);
  });

  it('on the self-hosted target, settle() waits for every deferred piece of work, a rejecting one included', async () => {
    const env = serverEnvFromBunConfig({ sqlite: new Database(':memory:'), blobDir: mkdtempSync(join(tmpdir(), 'myco-blobs-')) });
    const slow = later();
    let finished = false;
    env.afterResponse(slow.promise.then(() => { finished = true; }));
    env.afterResponse(Promise.reject(new Error('the work reports its own failure')));
    let settled = false;
    const settling = env.settle().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    slow.done();
    await settling;
    expect({ settled, finished }).toEqual({ settled: true, finished: true });
    await env.settle();
  });
});
