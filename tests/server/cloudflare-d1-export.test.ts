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
import {
  D1_EXPORT_BOUND_MS, D1_EXPORT_CANCEL_MARGIN_MS, D1_EXPORT_POLL_ATTEMPTS, D1ExportFailed, D1ExportRecordUnreadable, D1ExportUnfinished, D1ExportUnsettled,
  exportD1, exportRecordPath, type D1ExportOptions,
} from '@myco/server/cloudflare-d1-export.js';
import { transientReadFailure } from '@myco/server/object-read.js';
import { readD1ExportAnswer } from '@goondocks/myco-shared/d1-export';
import type { CloudflareFetch, OperatorLogin } from '@myco/server/cloudflare.js';

const POLL_CEILING = 5_000;
const ACCOUNT = 'acct';
const DATABASE = 'db-1';
const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/export`;

interface Job { bookmark: string; state: 'active' | 'complete' | 'error' }

/**
 * The provider's export API. `next` decides what each running export answers when asked after. `startAnswer`, when
 * set, replaces the answer to a request that starts an export — after the export has started, as a lost or
 * ambiguous answer does. `seen` is called with every request as it arrives.
 */
function provider(next: (job: Job) => Job['state'] = () => 'active') {
  const jobs: Job[] = [];
  const requests: Array<string | null> = [];
  const control: { startAnswer: (() => Response) | null; seen: (bookmark: string | null) => void } = { startAnswer: null, seen: () => {} };
  const fetch: CloudflareFetch = async (url, init) => {
    if (url.startsWith('https://signed.fixture/')) return new Response(`-- export ${url.slice('https://signed.fixture/'.length)}\n`);
    expect(url).toBe(ENDPOINT);
    if (requests.length >= POLL_CEILING) throw new Error('the export was polled without end');
    const body = JSON.parse(String(init.body)) as { current_bookmark?: string };
    const bookmark = body.current_bookmark ?? null;
    requests.push(bookmark);
    control.seen(bookmark);
    let job: Job | undefined;
    if (bookmark === null) {
      job = { bookmark: `bm-${jobs.length + 1}`, state: 'active' };
      jobs.push(job);
      if (control.startAnswer !== null) return control.startAnswer();
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
  return { fetch, jobs, requests, control, started: () => requests.filter((b) => b === null).length };
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

/** The record this machine keeps of its running export, as a test writes or reads it. */
const recordFile = () => exportRecordPath(dir, DATABASE);
const recorded = () => JSON.parse(fs.readFileSync(recordFile(), 'utf8')) as Record<string, unknown>;
const record = (fields: Record<string, unknown>) => fs.writeFileSync(recordFile(), JSON.stringify({ databaseId: DATABASE, tables: ['sessions'], schema: 'schema-1', ...fields }));

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
    // What the operator does next: wait out the margin, or delete the record once the export is known to have ended.
    expect((failure as Error).message).toContain(`run no backup for ${D1_EXPORT_CANCEL_MARGIN_MS / 60_000} min`);
    expect((failure as Error).message).toContain(`delete ${recordFile()}`);
    expect(api.started()).toBe(1);
    expect(recorded()).toMatchObject({ bookmark: 'bm-1', databaseId: DATABASE });
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

  it('keeps the start it was recorded with across every resume, so its bound runs from its first request', async () => {
    const api = provider();
    api.jobs.push({ bookmark: 'bm-old', state: 'active' });
    const startedAt = clock - 25 * 60_000;
    record({ bookmark: 'bm-old', startedAt, lastPolledAt: clock - 60_000 });
    const failure = await run(api.fetch).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(D1ExportUnfinished);
    // Five minutes were left of its bound: six polls, a minute apart, and the record still names its first request.
    expect({ polls: api.requests.length, startedAt: recorded().startedAt, started: api.started() }).toEqual({ polls: 6, startedAt, started: 0 });
  });
});

describe('an export a retry resumes', () => {
  it('asks again at once after a poll that did not land, and takes the one export\'s result', async () => {
    let asked = 0;
    const api = provider(() => (++asked >= 3 ? 'complete' : 'active'));
    let lost = false;
    const flaky: CloudflareFetch = async (url, init) => {
      if (!lost && JSON.parse(String(init.body ?? '{}')).current_bookmark === 'bm-1') { lost = true; throw new TypeError('fetch failed'); }
      return api.fetch(url, init);
    };
    await run(flaky);
    expect(api.started()).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8')).toBe('-- export bm-1\n');
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it('takes the result of the export it resumed when that export completed inside the bound under the same schema', async () => {
    const api = provider(() => 'complete');
    const lost: CloudflareFetch = async (url, init) => {
      if (url.startsWith('https://signed.fixture/')) throw new TypeError('fetch failed');
      return api.fetch(url, init);
    };
    await expect(run(lost)).rejects.toThrow('did not reach Cloudflare');
    await run(api.fetch);
    expect(api.requests).toEqual([null, 'bm-1', 'bm-1']);
    expect(fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8')).toBe('-- export bm-1\n');
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

  it('discards an export that completed past its bound rather than taking it as this snapshot', async () => {
    const api = provider(() => 'complete');
    api.jobs.push({ bookmark: 'bm-old', state: 'complete' });
    record({ bookmark: 'bm-old', startedAt: clock - D1_EXPORT_BOUND_MS - 1, lastPolledAt: clock - 60_000 });
    await run(api.fetch);
    expect(api.requests).toEqual(['bm-old', null, 'bm-2']);
    expect(fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8')).toBe('-- export bm-2\n');
  });
});

describe('an export whose starting request had no answer that settles it (#1455 F1)', () => {
  it('is recorded, and flushed, before its request is sent', async () => {
    const api = provider(() => 'complete');
    const onDisk: unknown[] = [];
    api.control.seen = (bookmark) => { if (bookmark === null) onDisk.push(recorded()); };
    await run(api.fetch);
    expect(onDisk).toEqual([expect.objectContaining({ bookmark: null, startedAt: 1_000_000, lastPolledAt: 1_000_000, schema: 'schema-1' })]);
  });

  for (const [what, answer] of [
    ['whose answer was lost after the export started', () => { throw new TypeError('fetch failed'); }],
    ['answered 503 after the export started', () => Response.json({ success: false, errors: [{ code: 7500, message: 'internal error' }] }, { status: 503 })],
    ['answered with a body that is not the API\'s', () => new Response('<html>gateway</html>', { status: 200 })],
  ] as const) {
    it(`never sends a second, in this backup or the next, until the margin has passed: a request ${what}`, async () => {
      const api = provider(() => 'complete');
      api.control.startAnswer = answer;
      const failure = await run(api.fetch).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(D1ExportUnsettled);
      // Not transient: the snapshot's own retry would be the second request.
      expect(transientReadFailure(failure)).toBe(false);
      expect((failure as Error).message).toContain(`no export starts here before ${new Date(1_000_000 + D1_EXPORT_CANCEL_MARGIN_MS).toISOString()}`);
      expect(recorded()).toMatchObject({ bookmark: null, startedAt: 1_000_000 });

      api.control.startAnswer = null;
      clock += D1_EXPORT_CANCEL_MARGIN_MS - 1;
      await expect(run(api.fetch)).rejects.toBeInstanceOf(D1ExportUnsettled);
      expect(api.started()).toBe(1);

      clock += 1;
      await run(api.fetch);
      expect(api.started()).toBe(2);
      expect(fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8')).toBe('-- export bm-2\n');
      expect(fs.existsSync(recordFile())).toBe(false);
    });
  }

  it('starts one once more after a refused login, since a refused credential started nothing', async () => {
    const api = provider(() => 'complete');
    let refusals = 0;
    api.control.startAnswer = () => {
      api.jobs.pop();
      api.control.startAnswer = null;
      refusals += 1;
      return Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 });
    };
    await run(api.fetch);
    expect({ refusals, started: api.started(), jobs: api.jobs.map((j) => j.bookmark) }).toEqual({ refusals: 1, started: 2, jobs: ['bm-1'] });
  });
});

describe('an export that completes on the request that starts it (#1455 finding 3)', () => {
  const completingAtOnce = (api: ReturnType<typeof provider>, bookmark: boolean) => () => {
    const job = api.jobs.at(-1)!;
    job.state = 'complete';
    return Response.json({ success: true, errors: [], result: { success: true, status: 'complete', ...(bookmark ? { at_bookmark: job.bookmark } : {}), result: { signed_url: `https://signed.fixture/${job.bookmark}` } } });
  };
  const downloadLostOnce = (api: ReturnType<typeof provider>) => {
    let lost = false;
    const fetch: CloudflareFetch = async (url, init) => {
      if (!lost && url.startsWith('https://signed.fixture/')) { lost = true; throw new TypeError('fetch failed'); }
      return api.fetch(url, init);
    };
    return fetch;
  };

  it('is recorded by its bookmark before its download, so a lost download is resumed rather than read as an unsettled start', async () => {
    const api = provider(() => 'complete');
    api.control.startAnswer = completingAtOnce(api, true);
    const fetch = downloadLostOnce(api);
    await expect(run(fetch)).rejects.toThrow('did not reach Cloudflare');
    expect(recorded()).toMatchObject({ bookmark: 'bm-1' });
    api.control.startAnswer = null;
    await run(fetch);
    expect({ requests: api.requests, output: fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8') }).toEqual({ requests: [null, 'bm-1'], output: '-- export bm-1\n' });
  });

  it('is recorded as nothing where it answers no bookmark: it runs no longer, and the next backup starts one', async () => {
    const api = provider(() => 'complete');
    api.control.startAnswer = completingAtOnce(api, false);
    const fetch = downloadLostOnce(api);
    await expect(run(fetch)).rejects.toThrow('did not reach Cloudflare');
    expect(fs.existsSync(recordFile())).toBe(false);
    api.control.startAnswer = null;
    await run(fetch);
    expect(api.started()).toBe(2);
  });
});

describe('a poll that does not say the export ended (#1455 F2)', () => {
  for (const [what, refusal] of [
    ['a D1 internal error', () => Response.json({ success: false, errors: [{ code: 7500, message: 'internal error' }] }, { status: 400 })],
    ['a 403 that is not an authentication error', () => Response.json({ success: false, errors: [{ code: 7403, message: 'not entitled' }] }, { status: 403 })],
    ['a 408', () => new Response('timeout', { status: 408 })],
    ['a success envelope with a failed result', () => Response.json({ success: true, result: { success: false, error: 'busy' } })],
  ] as const) {
    it(`keeps the export recorded and starts nothing on ${what}`, async () => {
      const api = provider();
      await expect(run(api.fetch, { boundMs: 60_000 })).rejects.toBeInstanceOf(D1ExportUnfinished);
      const refusing: CloudflareFetch = async (url, init) => {
        const bookmark = JSON.parse(String(init.body ?? '{}')).current_bookmark;
        if (bookmark !== undefined) { api.requests.push(bookmark); return refusal(); }
        return api.fetch(url, init);
      };
      const before = api.requests.length;
      const failure = await run(refusing).then(() => null, (error: unknown) => error as Error);
      expect(failure?.message).toContain(`was asked after ${D1_EXPORT_POLL_ATTEMPTS} times without an answer that settles it`);
      expect({ asked: api.requests.slice(before), started: api.started(), record: recorded().bookmark })
        .toEqual({ asked: Array(D1_EXPORT_POLL_ATTEMPTS).fill('bm-1'), started: 1, record: 'bm-1' });
    });
  }

  it('asks once after a record nothing has answered for past the margin, clears it when Cloudflare no longer answers for it, and starts one', async () => {
    const api = provider(() => 'complete');
    record({ bookmark: 'bm-gone', startedAt: clock - D1_EXPORT_CANCEL_MARGIN_MS - 5 * 60_000, lastPolledAt: clock - D1_EXPORT_CANCEL_MARGIN_MS });
    const lines: string[] = [];
    await run(api.fetch, { report: (line) => lines.push(line) });
    expect(api.requests).toEqual(['bm-gone', null, 'bm-1']);
    expect(lines.some((line) => line.includes('Cloudflare no longer runs it'))).toBe(true);
  });

  it('follows a record past the margin that Cloudflare still reports running, and starts nothing beside it', async () => {
    const api = provider();
    api.jobs.push({ bookmark: 'bm-live', state: 'active' });
    record({ bookmark: 'bm-live', startedAt: clock - D1_EXPORT_CANCEL_MARGIN_MS - 5 * 60_000, lastPolledAt: clock - D1_EXPORT_CANCEL_MARGIN_MS });
    await expect(run(api.fetch)).rejects.toBeInstanceOf(D1ExportUnfinished);
    expect({ requests: api.requests, started: api.started(), record: recorded().bookmark }).toEqual({ requests: ['bm-live', 'bm-live'], started: 0, record: 'bm-live' });
  });

  it('judges a record stale by its last answer, never by its start (M5)', async () => {
    const api = provider();
    api.jobs.push({ bookmark: 'bm-long', state: 'active' });
    // Started before the margin, answered for a minute ago: an export that may still run.
    record({ bookmark: 'bm-long', startedAt: clock - D1_EXPORT_CANCEL_MARGIN_MS - 10 * 60_000, lastPolledAt: clock - 60_000 });
    await expect(run(api.fetch)).rejects.toBeInstanceOf(D1ExportUnfinished);
    expect({ requests: api.requests, record: recorded().bookmark }).toEqual({ requests: ['bm-long'], record: 'bm-long' });
  });
});

describe('a record this machine cannot read (#1455 F4)', () => {
  for (const [what, body] of [['empty', ''], ['damaged', '{"bookmark":'], ['of another shape', '{"bookmark":1}']] as const) {
    it(`names the file and the remedy, and starts nothing, where it is ${what}`, async () => {
      const api = provider(() => 'complete');
      fs.writeFileSync(recordFile(), body);
      const failure = await run(api.fetch).then(() => null, (error: unknown) => error as Error);
      expect(failure).toBeInstanceOf(D1ExportRecordUnreadable);
      expect(failure!.message).toContain(recordFile());
      expect(failure!.message).toContain('delete it once none can be');
      expect(api.requests).toEqual([]);
    });
  }
});

describe('an export Cloudflare ends without a result', () => {
  it('fails naming the provider\'s reason, and records nothing running', async () => {
    const api = provider(() => 'error');
    await expect(run(api.fetch)).rejects.toBeInstanceOf(D1ExportFailed);
    await expect(run(api.fetch)).rejects.toThrow('the export was reset');
    expect(fs.existsSync(recordFile())).toBe(false);
  });
});

describe('a download that fails', () => {
  it('names no signed URL in its error', async () => {
    const api = provider(() => 'complete');
    const leaking: CloudflareFetch = async (url, init) => {
      if (url.startsWith('https://signed.fixture/')) throw new TypeError(`fetch failed for ${url}`);
      return api.fetch(url, init);
    };
    const failure = await run(leaking).then(() => null, (error: unknown) => error as Error);
    expect(failure!.message).toContain('[URL omitted]');
    expect(failure!.message).not.toContain('signed.fixture');
  });
});

describe('the one reading of an export answer (#1455 F7)', () => {
  const ok = (result: Record<string, unknown>) => ({ success: true, errors: [], result });
  it('ends an export only on an answer that says so for it', () => {
    expect(readD1ExportAnswer(200, ok({ status: 'complete', at_bookmark: 'b', result: { signed_url: 'https://s/1' } }), 'b')).toEqual({ kind: 'complete', bookmark: 'b', signedUrl: 'https://s/1' });
    expect(readD1ExportAnswer(200, ok({ status: 'error', error: 'reset' }), 'b')).toEqual({ kind: 'ended', bookmark: 'b', detail: 'reset' });
    const unsettled = [
      readD1ExportAnswer(400, { success: false, errors: [{ code: 7500, message: 'internal' }] }, 'b'),
      readD1ExportAnswer(403, { success: false, errors: [{ code: 7403, message: 'no' }] }, 'b'),
      readD1ExportAnswer(408, undefined, 'b'),
      readD1ExportAnswer(503, undefined, 'b'),
      readD1ExportAnswer(200, { success: false }, 'b'),
      readD1ExportAnswer(200, ok({ success: false, error: 'busy' }), 'b'),
      readD1ExportAnswer(200, ok({ error: 'no status' }), 'b'),
      readD1ExportAnswer(200, ok({ status: 'complete' }), 'b'),
      readD1ExportAnswer(200, undefined, 'b'),
      readD1ExportAnswer(200, ok({ status: 'active' }), null),
    ];
    expect(unsettled.map((reading) => reading.kind)).toEqual(Array(unsettled.length).fill('unknown'));
    expect([408, 429, 500, 503].map((status) => (readD1ExportAnswer(status, undefined, 'b') as { transient: boolean }).transient)).toEqual([true, true, true, true]);
  });

  it('reads an answer that names no status as running or unsettled, never as ended (M6b)', () => {
    for (const [what, result] of [['a bookmark and no status', { at_bookmark: 'b' }], ['nothing at all', {}]] as const) {
      for (const asked of ['b', null]) {
        const kind = readD1ExportAnswer(200, ok(result), asked).kind;
        expect({ what, asked, settles: kind === 'ended' || kind === 'complete' }).toEqual({ what, asked, settles: false });
      }
    }
    expect(readD1ExportAnswer(200, ok({ at_bookmark: 'b' }), null)).toEqual({ kind: 'running', bookmark: 'b' });
  });

  it('reads a credential the API refused as a refusal that started nothing', () => {
    expect(readD1ExportAnswer(401, undefined, null)).toEqual({ kind: 'refused-login', status: 401 });
    expect(readD1ExportAnswer(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, null)).toEqual({ kind: 'refused-login', status: 403 });
  });

  it('is the reading both callers of the export API act on, and neither reads an answer by itself', () => {
    for (const source of ['packages/myco/src/server/cloudflare-d1-export.ts', 'packages/myco-server/src/platform/cloudflare/recovery-export.ts']) {
      const text = fs.readFileSync(path.join(import.meta.dir, '..', '..', source), 'utf8');
      expect({ source, reads: text.includes('readD1ExportAnswer('), parsesItself: /at_bookmark|signed_url/.test(text) }).toEqual({ source, reads: true, parsesItself: false });
    }
  });
});
