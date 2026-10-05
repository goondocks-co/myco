/**
 * A hosted backup's D1 export (#1455): bounded, followed by its own bookmark,
 * and never started beside an export this machine may still have running.
 *
 * The provider is a fake of its export API. A request with no bookmark starts
 * an export; one with a bookmark asks after that export. The fake refuses to
 * run forever: past `POLL_CEILING` requests it throws, so an unbounded loop
 * fails by name rather than hanging the suite.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  D1_EXPORT_BOUND_MS, D1_EXPORT_CANCEL_MARGIN_MS, D1_EXPORT_DOWNLOAD_ATTEMPTS, D1_EXPORT_POLL_ATTEMPTS, D1ExportFailed, D1ExportRecordUnreadable, D1ExportUnfinished, D1ExportUnsettled,
  D1_QUERY_ATTEMPTS, D1ExportStartBudget, exportD1, exportRecordPath, exportResultPath, queryD1, releaseD1Export, releaseKeptD1Export, settleD1Export, type D1ExportOptions,
} from '@myco/server/cloudflare-d1-export.js';
import { transientReadFailure } from '@myco/server/object-read.js';
import { readD1ExportAnswer } from '@goondocks/myco-shared/d1-export';
import { D1_EXPORT_ANSWERS } from '../helpers/d1-export-answers.ts';
import type { CloudflareFetch, OperatorLogin } from '@myco/server/cloudflare.js';

const POLL_CEILING = 5_000;

/** A download as the signed URL serves one: its body and the length it declares. */
const sized = (body: string): Response => new Response(body, { headers: { 'content-length': String(new TextEncoder().encode(body).byteLength) } });
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
    if (url.startsWith('https://signed.fixture/')) return sized(`-- export ${url.slice('https://signed.fixture/'.length)}\n`);
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
/** Whether no export this machine recorded may still run: no record, or one whose result is downloaded and held. */
const noExportRunning = () => !fs.existsSync(recordFile()) || recorded().downloaded === true;
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
  it('does not charge an explicitly refused login against the new-export budget', async () => {
    const api = provider(() => 'complete');
    const startBudget = new D1ExportStartBudget();
    await run(api.fetch, { startBudget });
    releaseD1Export({ accountId: ACCOUNT, databaseId: DATABASE, output: path.join(dir, 'd1.sql'), recordDir: dir, login });
    let refused = false;
    const fetch: CloudflareFetch = async (url, init) => {
      if (!refused && url === ENDPOINT && !JSON.parse(String(init.body)).current_bookmark) {
        refused = true;
        return new Response(null, { status: 401 });
      }
      return api.fetch(url, init);
    };
    await run(fetch, { startBudget });
    expect(refused).toBe(true);
    expect(api.started()).toBe(2);
  });

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
    expect(noExportRunning()).toBe(true);
  });

  it('takes the result of the export it resumed when that export completed inside the bound under the same schema', async () => {
    const api = provider(() => 'complete');
    const lost: CloudflareFetch = async (url, init) => {
      if (url.startsWith('https://signed.fixture/')) throw new TypeError('fetch failed');
      return api.fetch(url, init);
    };
    await expect(run(lost)).rejects.toThrow('did not reach Cloudflare');
    await run(api.fetch);
    // The download is fetched again from the same export before this backup gives it up; the next one resumes that export.
    expect(api.requests).toEqual([null, 'bm-1', ...Array(D1_EXPORT_DOWNLOAD_ATTEMPTS - 1).fill('bm-1'), 'bm-1']);
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
    expect(api.requests).toEqual([null, 'bm-1', ...Array(D1_EXPORT_DOWNLOAD_ATTEMPTS - 1).fill('bm-1'), 'bm-1', null, 'bm-2']);
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
      expect(noExportRunning()).toBe(true);
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

  it('is recorded by its bookmark before its download, so a lost download is fetched again from that export rather than read as an unsettled start', async () => {
    const api = provider(() => 'complete');
    api.control.startAnswer = completingAtOnce(api, true);
    const lost = downloadLostOnce(api);
    const bookmarks: unknown[] = [];
    const fetch: CloudflareFetch = async (url, init) => {
      if (url.startsWith('https://signed.fixture/')) bookmarks.push(recorded().bookmark);
      return lost(url, init);
    };
    await run(fetch);
    expect({ bookmarks, requests: api.requests, output: fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8'), kept: !noExportRunning() })
      .toEqual({ bookmarks: ['bm-1', 'bm-1'], requests: [null, 'bm-1'], output: '-- export bm-1\n', kept: false });
  });

  it('is recorded as nothing where it answers no bookmark: it runs no longer, and its download is fetched again from the same URL', async () => {
    const api = provider(() => 'complete');
    api.control.startAnswer = completingAtOnce(api, false);
    const lost = downloadLostOnce(api);
    const recordedDuring: boolean[] = [];
    const fetch: CloudflareFetch = async (url, init) => {
      if (url.startsWith('https://signed.fixture/')) recordedDuring.push(fs.existsSync(recordFile()));
      return lost(url, init);
    };
    await run(fetch);
    expect({ recordedDuring, started: api.started(), requests: api.requests, output: fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8') })
      .toEqual({ recordedDuring: [false, false], started: 1, requests: [null], output: '-- export bm-1\n' });
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

/** An answer that nothing is exporting, as Cloudflare gives it for a bookmark whose export is no longer running. */
const NOTHING_EXPORTING = () => Response.json({ success: true, errors: [], messages: [], result: { success: false, error: 'Not currently exporting anything.' } });

/** `inner`, except that a poll of any bookmark in `gone` is answered that nothing is exporting. */
const nothingExportingFor = (gone: Set<string>, inner: CloudflareFetch): CloudflareFetch => async (url, init) => {
  if (url === ENDPOINT) {
    const bookmark = (JSON.parse(String(init.body)) as { current_bookmark?: string }).current_bookmark;
    if (bookmark !== undefined && gone.has(bookmark)) return NOTHING_EXPORTING();
  }
  return inner(url, init);
};

describe('a download that trickles, then stalls', () => {
  it('ends that attempt on the stall, asks after the same export, and resumes its bytes: no second export, no failure', async () => {
    const api = provider(() => 'complete');
    const whole = new TextEncoder().encode('-- export bm-1, the whole of it\n');
    const ranges: Array<string | null> = [];
    const gone = new Set<string>();
    const fetch = nothingExportingFor(gone, async (url, init) => {
      if (!url.startsWith('https://signed.fixture/')) return api.fetch(url, init);
      const range = new Headers(init.headers).get('range');
      ranges.push(range);
      // Once its result is served, Cloudflare answers the export's bookmark that nothing is exporting.
      gone.add('bm-1');
      if (range === null) {
        // The first bytes arrive, then nothing more: the connection stays open with no byte on it.
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(whole.slice(0, 8)); },
          pull() { return new Promise(() => {}); },
        }), { status: 200, headers: { 'content-length': String(whole.byteLength) } });
      }
      const from = Number(/^bytes=(\d+)-$/.exec(range)![1]);
      return new Response(whole.slice(from), { status: 206, headers: { 'content-range': `bytes ${from}-${whole.byteLength - 1}/${whole.byteLength}` } });
    });
    await run(fetch, { stallMs: 25, pollMs: 0 });
    expect({
      output: fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8'), ranges, started: api.started(), requests: api.requests,
      kept: !noExportRunning(), part: fs.existsSync(path.join(dir, 'd1.sql.part')),
    }).toEqual({ output: '-- export bm-1, the whole of it\n', ranges: [null, 'bytes=8-'], started: 1, requests: [null, 'bm-1'], kept: false, part: false });
  });

  it('takes a fresh download from the same export where it answers one, and never counts a total time against the download', async () => {
    const api = provider(() => 'complete');
    let asked = 0;
    const fetch: CloudflareFetch = async (url, init) => {
      if (url === ENDPOINT) {
        // Asked after again once its first download lapsed, the export answers a fresh one.
        const answer = await api.fetch(url, init);
        asked += 1;
        if (asked < 3) return answer;
        return Response.json({ success: true, errors: [], result: { success: true, status: 'complete', at_bookmark: 'bm-1', result: { signed_url: 'https://signed.fixture/bm-1?fresh' } } });
      }
      if (!url.endsWith('?fresh')) return new Response(null, { status: 403 });
      // Slow but never stalled: each byte arrives inside the stall, the whole takes several stalls' time.
      const bytes = new TextEncoder().encode('-- slow\n');
      let at = 0;
      return new Response(new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (at >= bytes.byteLength) { controller.close(); return; }
          controller.enqueue(bytes.slice(at, at + 1));
          at += 1;
        },
      }), { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
    };
    await run(fetch, { stallMs: 40, pollMs: 0 });
    expect({ output: fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8'), started: api.started(), requests: api.requests })
      .toEqual({ output: '-- slow\n', started: 1, requests: [null, 'bm-1', 'bm-1'] });
  });

  it('clears the record where the download is no longer served and nothing names another, so the next backup starts one', async () => {
    const api = provider(() => 'complete');
    const gone = new Set<string>();
    const fetch = nothingExportingFor(gone, async (url, init) => {
      if (!url.startsWith('https://signed.fixture/')) return api.fetch(url, init);
      gone.add('bm-1');
      return new Response(null, { status: 410 });
    });
    const failure = await run(fetch, { pollMs: 0 }).then(() => null, (error: unknown) => error as Error);
    expect({ transient: transientReadFailure(failure), said: failure?.message.includes('no longer served'), kept: fs.existsSync(recordFile()), started: api.started() })
      .toEqual({ transient: true, said: true, kept: false, started: 1 });
    await run(api.fetch, { pollMs: 0 });
    expect(api.started()).toBe(2);
  });
});

describe('a download that closes before its length', () => {
  it('is never taken as the result: the rest is fetched from where it stopped', async () => {
    const api = provider(() => 'complete');
    const whole = new TextEncoder().encode('-- export bm-1, closed early\n');
    const ranges: Array<string | null> = [];
    const fetch: CloudflareFetch = async (url, init) => {
      if (!url.startsWith('https://signed.fixture/')) return api.fetch(url, init);
      const range = new Headers(init.headers).get('range');
      ranges.push(range);
      if (range === null) {
        // The connection closes cleanly after the first bytes, short of the length the answer declared.
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(whole.slice(0, 10)); controller.close(); } }),
          { status: 200, headers: { 'content-length': String(whole.byteLength) } });
      }
      const from = Number(/^bytes=(\d+)-$/.exec(range)![1]);
      return new Response(whole.slice(from), { status: 206, headers: { 'content-range': `bytes ${from}-${whole.byteLength - 1}/${whole.byteLength}` } });
    };
    await run(fetch, { pollMs: 0 });
    expect({ output: fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8'), ranges, started: api.started() })
      .toEqual({ output: '-- export bm-1, closed early\n', ranges: [null, 'bytes=10-'], started: 1 });
  });
});

describe('a download served encoded anyway', () => {
  it('is asked for as stored, and taken whole where it comes encoded, its declared length counting bytes never seen here', async () => {
    const api = provider(() => 'complete');
    const asked: Array<string | null> = [];
    const fetch: CloudflareFetch = async (url, init) => {
      if (!url.startsWith('https://signed.fixture/')) return api.fetch(url, init);
      asked.push(new Headers(init.headers).get('accept-encoding'));
      // What a decoding fetch hands over: the whole SQL, under the encoded length.
      return new Response('-- export bm-1, decoded\n', { status: 200, headers: { 'content-encoding': 'gzip', 'content-length': '7' } });
    };
    await run(fetch, { pollMs: 0 });
    expect({ output: fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8'), asked }).toEqual({ output: '-- export bm-1, decoded\n', asked: ['identity'] });
  });
});

/** A download fake: `answers[n]` serves the n-th request, and every request's range and If-Range are recorded. */
function servedInTurn(api: ReturnType<typeof provider>, answers: Array<(range: string | null) => Response>) {
  const asked: Array<{ range: string | null; ifRange: string | null }> = [];
  const fetch: CloudflareFetch = async (url, init) => {
    if (!url.startsWith('https://signed.fixture/')) return api.fetch(url, init);
    const headers = new Headers(init.headers);
    asked.push({ range: headers.get('range'), ifRange: headers.get('if-range') });
    return answers[Math.min(asked.length - 1, answers.length - 1)]!(headers.get('range'));
  };
  return { fetch, asked };
}
const WHOLE = new TextEncoder().encode('-- export bm-1, twenty\n');
/** The first `n` bytes of the whole, then a clean close short of the declared length. */
const cutAt = (n: number, headers: Record<string, string> = {}) => () =>
  new Response(new ReadableStream({ start(c) { c.enqueue(WHOLE.slice(0, n)); c.close(); } }), { headers: { 'content-length': String(WHOLE.byteLength), ...headers } });
const whole = (headers: Record<string, string> = {}) => () => new Response(WHOLE, { headers: { 'content-length': String(WHOLE.byteLength), ...headers } });
const ranged = (start: number, total: number, headers: Record<string, string> = {}) => () =>
  new Response(WHOLE.slice(start), { status: 206, headers: { 'content-range': `bytes ${start}-${WHOLE.byteLength - 1}/${total}`, ...headers } });

describe('a resumed download that does not match what it resumes', () => {
  const output = () => fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8');

  it('refuses a range that starts anywhere but where its bytes stopped, and starts again from the first byte rather than splicing', async () => {
    const api = provider(() => 'complete');
    const served = servedInTurn(api, [cutAt(8), ranged(5, WHOLE.byteLength), whole()]);
    await run(served.fetch, { pollMs: 0 });
    expect({ output: output(), ranges: served.asked.map((a) => a.range) }).toEqual({ output: '-- export bm-1, twenty\n', ranges: [null, 'bytes=8-', null] });
  });

  it('sends back the first answer\'s ETag, and starts again where the range comes from another object', async () => {
    const api = provider(() => 'complete');
    const served = servedInTurn(api, [cutAt(8, { etag: '"v1"' }), ranged(8, WHOLE.byteLength, { etag: '"v2"' }), whole({ etag: '"v2"' })]);
    await run(served.fetch, { pollMs: 0 });
    expect({ output: output(), asked: served.asked }).toEqual({
      output: '-- export bm-1, twenty\n',
      asked: [{ range: null, ifRange: null }, { range: 'bytes=8-', ifRange: '"v1"' }, { range: null, ifRange: null }],
    });
  });

  it('starts again where the range comes from an object of another length', async () => {
    const api = provider(() => 'complete');
    const served = servedInTurn(api, [cutAt(8, { etag: '"v1"' }), ranged(8, WHOLE.byteLength + 5, { etag: '"v1"' }), whole({ etag: '"v1"' })]);
    await run(served.fetch, { pollMs: 0 });
    expect({ output: output(), ranges: served.asked.map((a) => a.range) }).toEqual({ output: '-- export bm-1, twenty\n', ranges: [null, 'bytes=8-', null] });
  });

  it('never appends a range to an encoded answer, and drops an encoded partial file its stream broke off', async () => {
    const api = provider(() => 'complete');
    // Its first bytes are written before the connection breaks off.
    const broken = () => new Response(new ReadableStream({ start(c) { c.enqueue(WHOLE.slice(0, 4)); }, pull(c) { c.error(new TypeError('fetch failed')); } }), { headers: { 'content-encoding': 'gzip' } });
    const served = servedInTurn(api, [cutAt(8), ranged(8, WHOLE.byteLength, { 'content-encoding': 'gzip' }), broken, whole()]);
    await run(served.fetch, { pollMs: 0 });
    expect({ output: output(), ranges: served.asked.map((a) => a.range) }).toEqual({ output: '-- export bm-1, twenty\n', ranges: [null, 'bytes=8-', null, null] });
  });

  it('never takes an answer that declares no length as whole', async () => {
    const api = provider(() => 'complete');
    const served = servedInTurn(api, [() => new Response(WHOLE.slice(0, 8)), whole()]);
    await run(served.fetch, { pollMs: 0 });
    expect({ output: output(), requests: served.asked.length }).toEqual({ output: '-- export bm-1, twenty\n', requests: 2 });
  });
});

describe('a download no longer served while its export is reported running', () => {
  it('keeps the export recorded and starts no second one', async () => {
    const api = provider(() => 'complete');
    let asked = 0;
    const fetch: CloudflareFetch = async (url, init) => {
      if (url === ENDPOINT) {
        asked += 1;
        // Asked after once more for its download, the export answers that it is running.
        if (asked === 3) {
          api.requests.push((JSON.parse(String(init.body)) as { current_bookmark?: string }).current_bookmark ?? null);
          return Response.json({ success: true, errors: [], result: { success: true, status: 'active', at_bookmark: 'bm-1' } });
        }
        return api.fetch(url, init);
      }
      return new Response(null, { status: 403 });
    };
    const failure = await run(fetch, { pollMs: 0 }).then(() => null, (error: unknown) => error as Error);
    expect({ transient: transientReadFailure(failure), kept: fs.existsSync(recordFile()) ? recorded().bookmark : null, requests: api.requests, started: api.started() })
      .toEqual({ transient: true, kept: 'bm-1', requests: [null, 'bm-1', 'bm-1'], started: 1 });
  });
});

describe('a download whose answer never begins', () => {
  it('ends that attempt on the stall and fetches it again from the same export', async () => {
    const api = provider(() => 'complete');
    let served = 0;
    const fetch: CloudflareFetch = async (url, init) => {
      if (!url.startsWith('https://signed.fixture/')) return api.fetch(url, init);
      served += 1;
      if (served === 1) return new Promise<Response>(() => {});
      return api.fetch(url, init);
    };
    await run(fetch, { stallMs: 25, pollMs: 0 });
    expect({ served, started: api.started(), output: fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8') }).toEqual({ served: 2, started: 1, output: '-- export bm-1\n' });
  });
});

describe('a recorded export Cloudflare says nothing is exporting for', () => {
  it('is settled as ended, its record cleared, and a new export started after it', async () => {
    const api = provider(() => 'complete');
    record({ bookmark: 'b-finished', startedAt: clock - 120_000, lastPolledAt: clock - 60_000 });
    await run(nothingExportingFor(new Set(['b-finished']), api.fetch), { pollMs: 0 });
    expect({ requests: api.requests, started: api.started(), output: fs.readFileSync(path.join(dir, 'd1.sql'), 'utf8'), kept: !noExportRunning() })
      .toEqual({ requests: [null, 'bm-1'], started: 1, output: '-- export bm-1\n', kept: false });
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

  it('reads the answer that nothing is exporting as ended, where the result says it and where a refusal does', () => {
    expect(readD1ExportAnswer(200, ok({ success: false, error: 'Not currently exporting anything.' }), 'b1')).toEqual({ kind: 'ended', bookmark: 'b1', detail: 'Not currently exporting anything.', absent: true });
    expect(readD1ExportAnswer(400, { success: false, errors: [{ message: 'Not currently exporting anything.' }] }, 'b1')).toMatchObject({ kind: 'ended', bookmark: 'b1' });
    expect(readD1ExportAnswer(200, ok({ success: false, error: 'not currently exporting anything' }), 'b1')).toMatchObject({ kind: 'ended' });
    // Another refusal of the same shape stays unsettled, and so does one that says more than that.
    expect(readD1ExportAnswer(200, ok({ success: false, error: 'busy' }), 'b1')).toMatchObject({ kind: 'unknown' });
    expect(readD1ExportAnswer(200, ok({ success: false, error: 'Not currently exporting anything. Try again after the reset.' }), 'b1')).toMatchObject({ kind: 'unknown' });
    expect(readD1ExportAnswer(200, ok({ success: false, error: 'Error: Not currently exporting anything.' }), 'b1')).toMatchObject({ kind: 'unknown' });
  });

  it('reads a credential the API refused as a refusal that started nothing', () => {
    expect(readD1ExportAnswer(401, undefined, null)).toEqual({ kind: 'refused-login', status: 401 });
    expect(readD1ExportAnswer(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, null)).toEqual({ kind: 'refused-login', status: 403 });
  });
});

describe('the operator backup\'s export, driven through every known answer (#1484)', () => {
  it('acts on each answer as the one shared reading reads it', async () => {
    type Act = 'running' | 'complete' | 'ended' | 'unsettled';
    // What each reading makes the operator do with an export it has recorded.
    const acts: Record<ReturnType<typeof readD1ExportAnswer>['kind'], Act> = {
      running: 'running', complete: 'complete', ended: 'ended', 'refused-login': 'unsettled', unknown: 'unsettled',
    };
    for (const row of D1_EXPORT_ANSWERS) {
      fs.rmSync(recordFile(), { force: true });
      record({ bookmark: 'b1', startedAt: clock, lastPolledAt: clock });
      let downloads = 0;
      const fetch: CloudflareFetch = async (url) => {
        if (url.startsWith('https://signed.example/')) { downloads += 1; return sized('-- export\n'); }
        return new Response(row.body === undefined ? '<html>not json</html>' : JSON.stringify(row.body), { status: row.status });
      };
      const outcome = await settleD1Export({
        accountId: ACCOUNT, databaseId: DATABASE, output: path.join(dir, 'd1.sql'), recordDir: dir, login, fetch,
        now: () => clock, sleep: async () => { clock += 1; }, boundMs: 1, pollMs: 0,
      }).then((settled) => ({ settled }), (error: unknown) => ({ error }));
      const act: Act = 'error' in outcome
        ? (outcome.error instanceof D1ExportUnfinished ? 'running' : 'unsettled')
        : outcome.settled !== null && downloads === 1 ? 'complete' : 'ended';
      expect({ what: row.what, act, kept: act === 'unsettled' || act === 'running' ? !noExportRunning() : noExportRunning() })
        .toEqual({ what: row.what, act: acts[readD1ExportAnswer(row.status, row.body, 'b1').kind], kept: true });
    }
  });
});

describe('an export this machine already downloaded', () => {
  const sqlFile = () => path.join(dir, 'd1.sql');
  const settle = (fetch: CloudflareFetch) => settleD1Export({
    accountId: ACCOUNT, databaseId: DATABASE, output: sqlFile(), recordDir: dir, login, fetch, now: () => clock, sleep: async () => {},
  });
  const unasked: CloudflareFetch = async () => { throw new Error('a downloaded export asks nothing of Cloudflare'); };
  const resultOf = (text: string) => ({ bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });

  it('records the size and digest of the SQL it downloaded, and the hold it was taken under, once its bytes are on disk', async () => {
    const p = provider(() => 'complete');
    const opened = new Map<number, string>();
    const seen: string[] = [];
    const [openFile, syncFile, renameFile] = [fs.openSync.bind(fs), fs.fsyncSync.bind(fs), fs.renameSync.bind(fs)];
    const open = spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      const fd = openFile(...args);
      opened.set(fd, String(args[0]));
      return fd;
    }) as typeof fs.openSync);
    const sync = spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => { seen.push(`sync ${opened.get(fd)}`); syncFile(fd); });
    const rename = spyOn(fs, 'renameSync').mockImplementation((from: fs.PathLike, to: fs.PathLike) => { seen.push(`rename ${String(from)}`); renameFile(from, to); });
    try {
      await run(p.fetch, { holdToken: 'hold-1' });
    } finally { open.mockRestore(); sync.mockRestore(); rename.mockRestore(); }
    // The downloaded bytes are flushed before the rename publishes them, and the rename before the record says so.
    const part = `${sqlFile()}.part`;
    expect(seen.indexOf(`sync ${part}`)).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf(`sync ${part}`)).toBeLessThan(seen.indexOf(`rename ${part}`));
    expect(seen[seen.indexOf(`rename ${part}`) + 1]).toBe(`sync ${dir}`);
    expect(recorded()).toMatchObject({ downloaded: true, result: resultOf('-- export bm-1\n'), holdToken: 'hold-1' });
    expect(fs.existsSync(`${sqlFile()}.part`)).toBe(false);
  });

  it('is taken again inside its bound while its SQL is whole as downloaded, asking nothing of Cloudflare', async () => {
    record({ bookmark: 'bm-kept', startedAt: clock - D1_EXPORT_BOUND_MS + 60_000, lastPolledAt: clock - 60_000, downloaded: true, result: resultOf('-- kept\n'), holdToken: 'hold-1' });
    fs.writeFileSync(sqlFile(), '-- kept\n');
    expect(await settle(unasked)).toEqual({ schema: 'schema-1', startedAt: clock - D1_EXPORT_BOUND_MS + 60_000, holdToken: 'hold-1' });
    expect(fs.readFileSync(sqlFile(), 'utf8')).toBe('-- kept\n');
  });

  it('is discarded when its SQL is torn, changed or unrecorded, never built into a snapshot', async () => {
    for (const [what, written, result] of [
      ['torn', '-- ke', resultOf('-- kept\n')],
      ['changed at the same size', '-- kepT\n', resultOf('-- kept\n')],
      ['downloaded before its digest was recorded', '-- kept\n', undefined],
    ] as const) {
      const reports: string[] = [];
      record({ bookmark: 'bm-kept', startedAt: clock - 60_000, lastPolledAt: clock - 60_000, downloaded: true, ...(result === undefined ? {} : { result }) });
      fs.writeFileSync(sqlFile(), written);
      const settled = await settleD1Export({ accountId: ACCOUNT, databaseId: DATABASE, output: sqlFile(), recordDir: dir, login, fetch: unasked, now: () => clock, sleep: async () => {}, report: (line) => reports.push(line) });
      expect({ what, settled, record: fs.existsSync(recordFile()), sql: fs.existsSync(sqlFile()) }).toEqual({ what, settled: null, record: false, sql: false });
      expect(reports.join('\n')).toContain('no longer whole as downloaded');
    }
  });

  it('is discarded once past its bound, or once its result is gone, so the next snapshot exports afresh', async () => {
    for (const [startedAt, kept] of [[clock - D1_EXPORT_BOUND_MS, true], [clock - 60_000, false]] as const) {
      record({ bookmark: 'bm-old', startedAt, lastPolledAt: clock - 60_000, downloaded: true, result: resultOf('-- stale\n') });
      if (kept) fs.writeFileSync(sqlFile(), '-- stale\n');
      expect(await settle(unasked)).toBeNull();
      expect([fs.existsSync(recordFile()), fs.existsSync(sqlFile())]).toEqual([false, false]);
    }
  });

  it('is taken only by a capture under the hold it was taken under; another hold exports afresh', async () => {
    record({ bookmark: 'bm-kept', startedAt: clock - 60_000, lastPolledAt: clock - 60_000, downloaded: true, result: resultOf('-- kept\n'), holdToken: 'hold-old' });
    fs.writeFileSync(sqlFile(), '-- kept\n');
    const p = provider(() => 'complete');
    const reports: string[] = [];
    await run(p.fetch, { holdToken: 'hold-new', report: (line) => reports.push(line) });
    expect(p.started()).toBe(1);
    expect(reports.join('\n')).toContain('taken under another recovery hold');
    expect(recorded()).toMatchObject({ holdToken: 'hold-new', result: resultOf('-- export bm-1\n') });
  });

  it('goes with its hold when that hold is released, and stays for any other hold', () => {
    record({ bookmark: 'bm-kept', startedAt: clock, lastPolledAt: clock, downloaded: true, result: resultOf('-- kept\n'), holdToken: 'hold-1' });
    fs.writeFileSync(sqlFile(), '-- kept\n');
    releaseKeptD1Export(dir, DATABASE, 'hold-2');
    expect([fs.existsSync(recordFile()), fs.existsSync(exportResultPath(dir, DATABASE))]).toEqual([true, false]);
    fs.writeFileSync(exportResultPath(dir, DATABASE), '-- kept\n');
    releaseKeptD1Export(dir, DATABASE, 'hold-1');
    expect([fs.existsSync(recordFile()), fs.existsSync(exportResultPath(dir, DATABASE))]).toEqual([false, false]);
    // An export still running is never released with a hold.
    record({ bookmark: 'bm-live', startedAt: clock, lastPolledAt: clock, holdToken: 'hold-1' });
    releaseKeptD1Export(dir, DATABASE, 'hold-1');
    expect(fs.existsSync(recordFile())).toBe(true);
  });
});

describe('a read of the source database over the operator login', () => {
  const QUERY = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`;
  const rows = (results: unknown[]) => Response.json({ success: true, errors: [], result: [{ success: true, results }] });
  const refused = (code: number, status = 400) => Response.json({ success: false, errors: [{ code, message: 'refused' }], result: null }, { status });
  const context = (fetch: CloudflareFetch, extra: { login?: OperatorLogin; pauses?: number[] } = {}) => ({
    accountId: ACCOUNT, databaseId: DATABASE, output: path.join(dir, 'd1.sql'), recordDir: dir,
    login: extra.login ?? login, fetch, sleep: async (ms: number) => { extra.pauses?.push(ms); },
  });

  it('reads through the query endpoint, and reads again past a 7403 inside its bound', async () => {
    const sent: string[] = [];
    const answers = [refused(7403), rows([{ name: 'sessions' }])];
    const pauses: number[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(QUERY);
      sent.push((JSON.parse(String(init?.body)) as { sql: string }).sql);
      return answers.shift()!;
    }) as CloudflareFetch;
    expect(await queryD1(context(fetch, { pauses }), 'SELECT name FROM sqlite_master')).toEqual([{ name: 'sessions' }]);
    expect(sent).toEqual(['SELECT name FROM sqlite_master', 'SELECT name FROM sqlite_master']);
    expect(pauses.length).toBe(1);
  });

  it('stops a 7403 that persists at its bound, naming the code, and never reads again past it', async () => {
    let reads = 0;
    const fetch = (async () => { reads += 1; return refused(7403); }) as CloudflareFetch;
    const failure = await queryD1(context(fetch), 'SELECT 1').then(() => null, (error: unknown) => error as { transient: boolean; apiCodes: string[]; message: string });
    expect(reads).toBe(D1_QUERY_ATTEMPTS);
    expect({ transient: failure?.transient, codes: failure?.apiCodes }).toEqual({ transient: true, codes: ['7403'] });
    expect(failure?.message).toContain('[code: 7403]');
  });

  it('refreshes a refused login once, and fails a refusal that is not transient at once', async () => {
    const refreshedFrom: unknown[] = [];
    const refreshing: OperatorLogin = { ...login, refused: (used) => { refreshedFrom.push(used); } };
    const answers = [new Response('{}', { status: 401 }), rows([])];
    expect(await queryD1(context((async () => answers.shift()!) as CloudflareFetch, { login: refreshing }), 'SELECT 1')).toEqual([]);
    expect(refreshedFrom.length).toBe(1);

    let reads = 0;
    const fetch = (async () => { reads += 1; return refused(7500, 400); }) as CloudflareFetch;
    await expect(queryD1(context(fetch), 'SELECT 1')).rejects.toMatchObject({ transient: false });
    expect(reads).toBe(1);
  });
});
