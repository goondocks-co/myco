/**
 * A hosted backup's D1 export (#1455): bounded, followed by its own bookmark,
 * and never started beside an export this machine may still have running.
 *
 * The provider is a fake of its export API. A request with no bookmark starts
 * an export; one with a bookmark asks after that export. The fake refuses to
 * run forever: past `POLL_CEILING` requests it throws, so an unbounded loop
 * fails by name rather than hanging the suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { D1_EXPORT_BOUND_MS, D1ExportFailed, D1ExportUnfinished, exportD1, exportRecordPath, type D1ExportOptions } from '@myco/server/cloudflare-d1-export.js';
import type { CloudflareFetch, OperatorLogin } from '@myco/server/cloudflare.js';

const POLL_CEILING = 5_000;
const ACCOUNT = 'acct';
const DATABASE = 'db-1';
const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/export`;

interface Job { bookmark: string; state: 'active' | 'complete' | 'error' }

/** The provider's export API. `next` decides what each running export answers when asked after. */
function provider(next: (job: Job) => Job['state'] = () => 'active') {
  const jobs: Job[] = [];
  const requests: Array<string | null> = [];
  const fetch: CloudflareFetch = async (url, init) => {
    if (url.startsWith('https://signed.fixture/')) return new Response(`-- export ${url.slice('https://signed.fixture/'.length)}\n`);
    expect(url).toBe(ENDPOINT);
    if (requests.length >= POLL_CEILING) throw new Error('the export was polled without end');
    const body = JSON.parse(String(init.body)) as { current_bookmark?: string };
    const bookmark = body.current_bookmark ?? null;
    requests.push(bookmark);
    let job: Job | undefined;
    if (bookmark === null) {
      job = { bookmark: `bm-${jobs.length + 1}`, state: 'active' };
      jobs.push(job);
    } else {
      job = jobs.find((j) => j.bookmark === bookmark);
      if (job === undefined) return Response.json({ success: false, errors: [{ code: 7500, message: 'no such export' }] }, { status: 400 });
      if (job.state === 'active') job.state = next(job);
    }
    const result = job.state === 'complete'
      ? { success: true, status: 'complete', at_bookmark: job.bookmark, result: { signed_url: `https://signed.fixture/${job.bookmark}` } }
      : job.state === 'error' ? { success: true, status: 'error', error: 'the export was reset' } : { success: true, status: 'active', at_bookmark: job.bookmark };
    return Response.json({ success: true, errors: [], messages: [], result });
  };
  return { fetch, jobs, requests, started: () => requests.filter((b) => b === null).length };
}

const login: OperatorLogin = {
  current: async () => new Headers({ Authorization: 'Bearer operator' }),
  headers: async () => new Headers({ Authorization: 'Bearer operator' }),
  refused: () => {},
};

let dir: string;
let clock: number;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-d1-export-')); clock = 1_000_000; });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** One export call, on a clock each pause moves on by a minute. */
const run = (fetch: CloudflareFetch, extra: Partial<D1ExportOptions> = {}) => exportD1({
  accountId: ACCOUNT, databaseId: DATABASE, tables: ['sessions'], output: path.join(dir, 'd1.sql'), recordDir: dir, schema: 'schema-1',
  login, fetch, now: () => clock, sleep: async () => { clock += 60_000; }, ...extra,
});

describe('a D1 export that never completes', () => {
  it('stops at its bound, names why, and leaves the export recorded rather than starting another', async () => {
    const api = provider();
    const failure = await run(api.fetch).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(D1ExportUnfinished);
    expect((failure as Error).message).toContain(`did not finish within ${D1_EXPORT_BOUND_MS / 60_000} min`);
    expect((failure as Error).message).toContain('at bookmark bm-1');
    expect((failure as Error).message).toContain('no second export was started');
    expect(api.started()).toBe(1);
    expect(JSON.parse(fs.readFileSync(exportRecordPath(dir, DATABASE), 'utf8'))).toMatchObject({ bookmark: 'bm-1', databaseId: DATABASE });
  });

  it('is resumed, never joined by a second, when a retry comes while it may still be live', async () => {
    const api = provider();
    await expect(run(api.fetch)).rejects.toBeInstanceOf(D1ExportUnfinished);
    // The #1452 retry, and a later backup: each asks after the export it holds, and starts nothing while it runs.
    await expect(run(api.fetch)).rejects.toBeInstanceOf(D1ExportUnfinished);
    expect(api.started()).toBe(1);
    expect(api.requests.slice(-1)).toEqual(['bm-1']);

    // Once it ends, the next export starts, and only then.
    api.jobs[0]!.state = 'error';
    await run(api.fetch, { now: () => clock, sleep: async () => { clock += 1_000; } }).catch(() => {});
    expect(api.requests.indexOf(null, 1)).toBeGreaterThan(api.requests.lastIndexOf('bm-1'));
  });
});

describe('an export a retry resumes', () => {
  it('takes the result of the export it resumed when that export started inside the bound under the same schema', async () => {
    let asked = 0;
    const api = provider(() => (++asked >= 3 ? 'complete' : 'active'));
    // The first attempt loses its connection after the export started.
    let lost = false;
    const flaky: CloudflareFetch = async (url, init) => {
      if (!lost && JSON.parse(String(init.body ?? '{}')).current_bookmark === 'bm-1') { lost = true; throw new TypeError('fetch failed'); }
      return api.fetch(url, init);
    };
    await expect(run(flaky)).rejects.toThrow('did not reach Cloudflare');
    await run(flaky);
    expect(api.started()).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8')).toBe('-- export bm-1\n');
    expect(fs.existsSync(exportRecordPath(dir, DATABASE))).toBe(false);
  });

  it('drives an export taken under another schema to its end, discards it, and only then starts one', async () => {
    const api = provider(() => 'complete');
    const lost: CloudflareFetch = async (url, init) => {
      if (url.startsWith('https://signed.fixture/')) throw new TypeError('fetch failed');
      return api.fetch(url, init);
    };
    await expect(run(lost)).rejects.toThrow('did not reach Cloudflare');
    await run(api.fetch, { schema: 'schema-2' });
    expect(api.requests).toEqual([null, 'bm-1', 'bm-1', null, 'bm-2']);
    expect(fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8')).toBe('-- export bm-2\n');
  });
});

describe('an export Cloudflare ends without a result', () => {
  it('fails naming the provider\'s reason, and records nothing running', async () => {
    const api = provider(() => 'error');
    await expect(run(api.fetch)).rejects.toBeInstanceOf(D1ExportFailed);
    await expect(run(api.fetch)).rejects.toThrow('the export was reset');
    expect(fs.existsSync(exportRecordPath(dir, DATABASE))).toBe(false);
  });
});
