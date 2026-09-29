/**
 * A hosted backup's D1 export, driven through the provider's export API by
 * this process rather than by `wrangler d1 export` (#1455).
 *
 * An export is one job on Cloudflare's side, named by the bookmark each poll
 * answers, and it pauses the database's queries while it runs. Wrangler polls
 * that job with no bound and keeps its bookmark to itself, so a caller could
 * neither stop waiting nor tell whether the job it abandoned was still live:
 * killing the command leaves the export running, and the next attempt's fresh
 * request starts a second one beside it.
 *
 * Here the bookmark is this machine's, recorded as soon as an export answers
 * one and cleared only once the export it names has ended and its result is
 * on disk. Every export starts by resuming the
 * recorded one:
 *
 * - An export started inside the bound (a retry after a transient failure)
 *   is polled on by its bookmark, and its result is the snapshot, when the
 *   schema it started under is the schema now.
 * - Any other recorded export is driven to its end and its result discarded
 *   before a new one starts, so two exports never run at once from here.
 * - An export that runs past `D1_EXPORT_BOUND_MS` from its start is reported
 *   with its cause and left recorded: nothing starts another while it may be
 *   live, and the next backup resumes it first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ObjectReadError, transientStatus } from './object-read.js';
import type { CloudflareFetch, OperatorLogin } from './cloudflare.js';

/**
 * How long one export may run, from its first request to its completion. A backup's export takes minutes; this is
 * several times that, so only an export that is not finishing reaches it.
 */
export const D1_EXPORT_BOUND_MS = 30 * 60_000;
/** The least time between two polls of one export, so an answer that arrives at once is not asked for again at once. */
export const D1_EXPORT_POLL_MS = 2_000;
/** How long one poll or the download may wait for Cloudflare to begin answering. */
const D1_EXPORT_REQUEST_MS = 60_000;

/** The provider's origin, and the only one an operator credential is sent to. */
const API_ORIGIN = 'https://api.cloudflare.com';

/** The export this machine has running against one database, as it records it. */
const recordSchema = z.object({
  databaseId: z.string(),
  bookmark: z.string(),
  startedAt: z.number(),
  /** The schema the export started under; a retry reuses the export only while the schema is the same. */
  schema: z.string(),
});
type ExportRecord = z.infer<typeof recordSchema>;

/** An export that did not end inside its bound. It may still be running, so nothing starts another beside it. */
export class D1ExportUnfinished extends Error {
  constructor(readonly record: ExportRecord, readonly elapsedMs: number) {
    super(`the D1 export started ${new Date(record.startedAt).toISOString()} did not finish within ${Math.round(D1_EXPORT_BOUND_MS / 60_000)} min `
      + `(Cloudflare still reports it running after ${Math.round(elapsedMs / 60_000)} min, at bookmark ${record.bookmark}); `
      + 'it pauses the database\'s queries while it runs, so no second export was started, and the next backup resumes this one first');
    this.name = 'D1ExportUnfinished';
  }
}

/** An export Cloudflare ended without a result. */
export class D1ExportFailed extends Error {
  constructor(detail: string) {
    super(`Cloudflare ended the D1 export without a result: ${detail}`);
    this.name = 'D1ExportFailed';
  }
}

export interface D1ExportOptions {
  accountId: string;
  databaseId: string;
  tables: readonly string[];
  /** The file the export's SQL is written to. */
  output: string;
  /** The directory this machine records its running export in, shared by every backup of the database. */
  recordDir: string;
  /** The schema the caller read before the export, which a resumed export must still match. */
  schema: string;
  login: OperatorLogin;
  fetch?: CloudflareFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test-only overrides of the bound and the pause between polls. */
  boundMs?: number;
  pollMs?: number;
  report?: (line: string) => void;
}

type PollAnswer = { status: 'running'; bookmark: string } | { status: 'complete'; signedUrl: string } | { status: 'ended'; detail: string };

const answerSchema = z.object({
  success: z.boolean().optional(),
  result: z.object({
    success: z.boolean().optional(),
    status: z.string().optional(),
    at_bookmark: z.string().optional(),
    error: z.string().optional(),
    result: z.object({ signed_url: z.string().optional() }).optional(),
  }).optional(),
});

const redacted = (text: string): string => text.replace(/https:\/\/\S+/g, '[URL omitted]').slice(0, 400);

/** Where the export running against `databaseId` is recorded. */
export function exportRecordPath(recordDir: string, databaseId: string): string {
  return path.join(recordDir, `d1-export-${databaseId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function readRecord(file: string): ExportRecord | null {
  if (!fs.existsSync(file)) return null;
  return recordSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function writeRecord(file: string, record: ExportRecord): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/**
 * Export `tables` to `output`, never beside another export this machine has running, and within the bound. Throws
 * `D1ExportUnfinished` when the export outlives its bound, `D1ExportFailed` when Cloudflare ends it without a result,
 * and a transient `ObjectReadError` for a request that did not land; the export stays recorded through the last, so a
 * retry resumes it.
 */
export async function exportD1(options: D1ExportOptions): Promise<void> {
  const fetchApi = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const boundMs = options.boundMs ?? D1_EXPORT_BOUND_MS;
  const pollMs = options.pollMs ?? D1_EXPORT_POLL_MS;
  const file = exportRecordPath(options.recordDir, options.databaseId);
  const endpoint = `${API_ORIGIN}/client/v4/accounts/${encodeURIComponent(options.accountId)}/d1/database/${encodeURIComponent(options.databaseId)}/export`;

  /** One poll: a fresh request with no bookmark starts an export; one with a bookmark asks after that export. */
  const poll = async (bookmark: string | null): Promise<PollAnswer> => {
    for (let attempt = 0; ; attempt += 1) {
      const used = options.login.current();
      const headers = new Headers(await used);
      headers.set('content-type', 'application/json');
      let response: Response;
      try {
        response = await fetchApi(endpoint, {
          method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(D1_EXPORT_REQUEST_MS),
          body: JSON.stringify({ output_format: 'polling', dump_options: { tables: [...options.tables] }, ...(bookmark === null ? {} : { current_bookmark: bookmark }) }),
        });
      } catch (error) {
        throw new ObjectReadError(`the D1 export request did not reach Cloudflare (${(error as Error).message})`, { transient: true, cause: error });
      }
      if ((response.status === 401 || response.status === 403) && attempt === 0) {
        await response.body?.cancel();
        options.login.refused(used);
        continue;
      }
      const text = await response.text().catch((error: unknown) => {
        throw new ObjectReadError('the D1 export answer stopped before it arrived', { transient: true, cause: error });
      });
      if (!response.ok) {
        if (transientStatus(response.status)) throw new ObjectReadError(`Cloudflare answered the D1 export HTTP ${response.status}`, { transient: true });
        // A bookmark the provider no longer answers for names an export that has ended.
        if (bookmark !== null) return { status: 'ended', detail: `HTTP ${response.status}: ${redacted(text)}` };
        throw new D1ExportFailed(`HTTP ${response.status}: ${redacted(text)}`);
      }
      let parsed: z.infer<typeof answerSchema>;
      try { parsed = answerSchema.parse(JSON.parse(text)); } catch { throw new D1ExportFailed('Cloudflare answered the export with an unreadable body'); }
      const held = parsed.result;
      if (parsed.success !== true || held === undefined || held.success === false) return { status: 'ended', detail: redacted(held?.error ?? text) };
      if (held.status === 'complete') {
        const signedUrl = held.result?.signed_url;
        if (signedUrl === undefined) throw new D1ExportFailed('Cloudflare reported the export complete with no download');
        return { status: 'complete', signedUrl };
      }
      if (held.status === 'error') return { status: 'ended', detail: redacted(held.error ?? 'the export failed') };
      const at = held.at_bookmark ?? bookmark;
      if (at === null) throw new D1ExportFailed('Cloudflare reported the export running with no bookmark to follow it by');
      return { status: 'running', bookmark: at };
    }
  };

  /** Poll `record`'s export until it ends or its bound passes, keeping the record current. */
  const follow = async (record: ExportRecord): Promise<{ record: ExportRecord; answer: Exclude<PollAnswer, { status: 'running' }> }> => {
    let current = record;
    for (;;) {
      const answer = await poll(current.bookmark);
      if (answer.status !== 'running') return { record: current, answer };
      if (answer.bookmark !== current.bookmark) {
        current = { ...current, bookmark: answer.bookmark };
        writeRecord(file, current);
      }
      const elapsed = now() - current.startedAt;
      if (elapsed >= boundMs) throw new D1ExportUnfinished(current, elapsed);
      await sleep(pollMs);
    }
  };

  const download = async (signedUrl: string): Promise<void> => {
    // The signed URL is a capability of its own, fetched with no operator credential.
    let response: Response;
    try {
      response = await fetchApi(signedUrl, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(D1_EXPORT_REQUEST_MS * 10) });
    } catch (error) {
      throw new ObjectReadError(`the D1 export download did not reach Cloudflare (${(error as Error).message})`, { transient: true, cause: error });
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new ObjectReadError(`the D1 export download failed (HTTP ${response.status})`, { transient: transientStatus(response.status) || [403, 404, 410].includes(response.status) });
    }
    try {
      fs.writeFileSync(options.output, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
    } catch (error) {
      throw new ObjectReadError(`the D1 export download stopped before it arrived: ${(error as Error).message}`, { transient: true, cause: error });
    }
  };

  // An export this machine already has recorded is resolved before anything new starts.
  const recorded = readRecord(file);
  if (recorded !== null) {
    options.report?.(`Resuming the D1 export this machine started ${new Date(recorded.startedAt).toISOString()} before starting another`);
    const ended = await follow(recorded);
    // Its result is this snapshot only while it is recent enough to be one, and taken under the schema now.
    if (ended.answer.status === 'complete' && ended.record.schema === options.schema && now() - ended.record.startedAt < boundMs) {
      await download(ended.answer.signedUrl);
      fs.rmSync(file, { force: true });
      return;
    }
    // Ended, or finished under a schema that is not the one now: it is not this snapshot, and it no longer runs.
    fs.rmSync(file, { force: true });
  }

  // The export is recorded by the first bookmark it answers, before anything else is asked of it. The one moment it is
  // not recorded is between that request landing and its answer arriving: an answer lost there leaves an export no
  // one polls, which Cloudflare ends on its own.
  const startedAt = now();
  const first = await poll(null);
  if (first.status === 'ended') throw new D1ExportFailed(first.detail);
  const outcome = first.status === 'complete'
    ? { answer: first }
    : await (async () => {
      const running: ExportRecord = { databaseId: options.databaseId, bookmark: first.bookmark, startedAt, schema: options.schema };
      writeRecord(file, running);
      await sleep(pollMs);
      return follow(running);
    })();
  if (outcome.answer.status === 'ended') {
    fs.rmSync(file, { force: true });
    throw new D1ExportFailed(outcome.answer.detail);
  }
  await download(outcome.answer.signedUrl);
  fs.rmSync(file, { force: true });
}
