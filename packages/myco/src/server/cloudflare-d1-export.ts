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
 * Here every export is this machine's record before it is Cloudflare's job:
 * the record is written, and flushed to disk, before the request that starts
 * the export is sent, and names the export by its bookmark once one is
 * answered. It is cleared only once the export it names has ended, on an
 * answer that says so, and its result is on disk. So a request whose answer
 * is lost leaves a record with no bookmark, and nothing starts another export
 * beside the one it may have started until `D1_EXPORT_CANCEL_MARGIN_MS` has
 * passed. Every backup settles the recorded export before it reads the
 * database (`settleD1Export`), since a running export pauses that read:
 *
 * - A record nothing has asked after for `D1_EXPORT_CANCEL_MARGIN_MS` names
 *   no running export, and is cleared.
 * - A record with no bookmark is an export whose start was never answered;
 *   inside the margin nothing starts another, and the backup says why.
 * - Any other record is polled by its bookmark to its end. Its result is the
 *   snapshot where it completed inside `D1_EXPORT_BOUND_MS` of its start under
 *   the schema the backup reads; otherwise it is discarded.
 * - An export that runs past `D1_EXPORT_BOUND_MS` from its start is reported
 *   with its cause and left recorded, and the next backup resumes it first.
 *
 * What an answer says is read once for every caller of this API
 * (`readD1ExportAnswer`): only `complete` or `error` for the export ends it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readD1ExportAnswer, type D1ExportReading } from '@goondocks/myco-shared/d1-export';
import { ObjectReadError } from './object-read.js';
import type { CloudflareFetch, OperatorLogin } from './cloudflare.js';

/**
 * How long one export may run, from its first request to its completion. A backup's export takes minutes; this is
 * several times that, so only an export that is not finishing reaches it.
 */
export const D1_EXPORT_BOUND_MS = 30 * 60_000;
/**
 * How long after the last answer about an export (or the request that started it) this machine takes it to be no
 * longer running. Twice the bound: an export ends by completing, or by Cloudflare cancelling it once nothing polls it,
 * and either happens well inside the time a polled export is allowed to run, so a record this old names no live export.
 */
export const D1_EXPORT_CANCEL_MARGIN_MS = 2 * D1_EXPORT_BOUND_MS;
/** The least time between two polls of one export, so an answer that arrives at once is not asked for again at once. */
export const D1_EXPORT_POLL_MS = 2_000;
/**
 * How many polls of one export in a row may go without an answer that settles it before the backup stops asking. Each
 * is retried at once rather than after the snapshot's backoff: an export nothing polls is cancelled.
 */
export const D1_EXPORT_POLL_ATTEMPTS = 5;
/** How long one poll or the download may wait for Cloudflare to begin answering. */
const D1_EXPORT_REQUEST_MS = 60_000;

/** The provider's origin, and the only one an operator credential is sent to. */
const API_ORIGIN = 'https://api.cloudflare.com';

/** The export this machine has running against one database, as it records it. */
const recordSchema = z.object({
  databaseId: z.string(),
  /** The tables the export was asked for, which every poll after it repeats. */
  tables: z.array(z.string()),
  /** The export's bookmark, or null for an export whose starting request has had no answer that names one. */
  bookmark: z.string().nullable(),
  /** When the request that started the export was sent; the bound runs from here, across every resume. */
  startedAt: z.number(),
  /** When Cloudflare last answered for the export, or when it was requested where nothing has answered since. */
  lastPolledAt: z.number(),
  /** The schema the export started under; a retry reuses the export only while the schema is the same. */
  schema: z.string(),
});
type ExportRecord = z.infer<typeof recordSchema>;

const iso = (at: number): string => new Date(at).toISOString();
const redacted = (text: string): string => text.replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 400);

/** An export that did not end inside its bound. It may still be running, so nothing starts another beside it. */
export class D1ExportUnfinished extends Error {
  constructor(readonly record: ExportRecord, readonly elapsedMs: number, file: string, marginMs: number) {
    super(`the D1 export started ${iso(record.startedAt)} did not finish within ${Math.round(D1_EXPORT_BOUND_MS / 60_000)} min `
      + `(Cloudflare still reports it running after ${Math.round(elapsedMs / 60_000)} min, at bookmark ${record.bookmark}); `
      + 'it pauses the database\'s queries while it runs, so no second export was started. '
      + `Cloudflare cancels an export nothing polls: run no backup for ${Math.round(marginMs / 60_000)} min, until ${iso(record.lastPolledAt + marginMs)}, `
      + `and the next backup after that finds it ended; each backup before then resumes it first. To start one sooner, once you know it has ended, delete ${file}`);
    this.name = 'D1ExportUnfinished';
  }
}

/**
 * An export whose starting request had no answer that says whether it started. It may be running with nothing
 * following it, so nothing starts another, in this backup or the next, until the margin has passed. Never transient:
 * trying again is exactly the second request this refuses.
 */
export class D1ExportUnsettled extends ObjectReadError {
  constructor(readonly record: ExportRecord, detail: string, marginMs: number) {
    super(`the D1 export requested ${iso(record.startedAt)} had no answer that says whether it started (${redacted(detail)}); `
      + 'it may be running with nothing following it, and it pauses the database\'s queries while it runs, '
      + `so no export starts here before ${iso(record.lastPolledAt + marginMs)}, when Cloudflare no longer runs one nothing asked after`, { transient: false });
    this.name = 'D1ExportUnsettled';
  }
}

/** An export Cloudflare ended without a result. */
export class D1ExportFailed extends Error {
  constructor(detail: string) {
    super(`Cloudflare ended the D1 export without a result: ${redacted(detail)}`);
    this.name = 'D1ExportFailed';
  }
}

/** A record of a running export that cannot be read, so whether an export is running is not known. */
export class D1ExportRecordUnreadable extends Error {
  constructor(readonly file: string, marginMs: number) {
    super(`this machine's record of its running D1 export, ${file}, is empty or damaged, so whether an export is still running is not known; `
      + `delete it once none can be (${Math.round(marginMs / 60_000)} min after the last backup of this Deployment), then back up again`);
    this.name = 'D1ExportRecordUnreadable';
  }
}

/** What every step of an export needs: where it is recorded, who asks, and on what clock. */
export interface D1ExportContext {
  accountId: string;
  databaseId: string;
  /** The file the export's SQL is written to. */
  output: string;
  /** The directory this machine records its running export in, shared by every backup of the database. */
  recordDir: string;
  login: OperatorLogin;
  fetch?: CloudflareFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test-only overrides of the bound, the cancel margin and the pause between polls. */
  boundMs?: number;
  marginMs?: number;
  pollMs?: number;
  report?: (line: string) => void;
}

export interface D1ExportOptions extends D1ExportContext {
  tables: readonly string[];
  /** The schema the caller read before the export, which a resumed export must still match. */
  schema: string;
  /**
   * The recorded export, as `settleD1Export` settled it before the caller read the schema. Omitted, the export
   * settles it itself.
   */
  settled?: SettledExport | null;
}

/** A recorded export that completed inside its bound, its SQL already at the output. */
export interface SettledExport { schema: string; startedAt: number }

/** Where the export running against `databaseId` is recorded. */
export function exportRecordPath(recordDir: string, databaseId: string): string {
  return path.join(recordDir, `d1-export-${databaseId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function readRecord(file: string, marginMs: number): ExportRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new D1ExportRecordUnreadable(file, marginMs); }
  const read = recordSchema.safeParse(parsed);
  if (!read.success) throw new D1ExportRecordUnreadable(file, marginMs);
  return read.data;
}

/** Write `record` in place of the one before it, on disk before this returns: it is what stops a second export. */
function writeRecord(file: string, record: ExportRecord): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeSync(handle, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

/** The steps of one export, over one context. */
function exporter(context: D1ExportContext) {
  const fetchApi = context.fetch ?? globalThis.fetch;
  const now = context.now ?? Date.now;
  const sleep = context.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const boundMs = context.boundMs ?? D1_EXPORT_BOUND_MS;
  const marginMs = context.marginMs ?? D1_EXPORT_CANCEL_MARGIN_MS;
  const pollMs = context.pollMs ?? D1_EXPORT_POLL_MS;
  const file = exportRecordPath(context.recordDir, context.databaseId);
  const endpoint = `${API_ORIGIN}/client/v4/accounts/${encodeURIComponent(context.accountId)}/d1/database/${encodeURIComponent(context.databaseId)}/export`;

  /**
   * One request of the export API, read. A request that got no whole answer reads as `unknown`: it knows no more.
   * The credential is refreshed and the request sent again once where the API refused it, since a refused credential
   * is refused before the request does anything.
   */
  const ask = async (tables: readonly string[], bookmark: string | null, beforeRetry?: () => void): Promise<D1ExportReading> => {
    for (let attempt = 0; ; attempt += 1) {
      const used = context.login.current();
      const headers = new Headers(await used);
      headers.set('content-type', 'application/json');
      if (attempt > 0) beforeRetry?.();
      let response: Response;
      try {
        response = await fetchApi(endpoint, {
          method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(D1_EXPORT_REQUEST_MS),
          body: JSON.stringify({ output_format: 'polling', dump_options: { tables: [...tables] }, ...(bookmark === null ? {} : { current_bookmark: bookmark }) }),
        });
      } catch (error) {
        return { kind: 'unknown', bookmark, cause: 'http', status: null, transient: true, detail: `the request did not reach Cloudflare: ${(error as Error).message}` };
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        return { kind: 'unknown', bookmark, cause: 'http', status: response.status, transient: true, detail: `the answer stopped before it arrived: ${(error as Error).message}` };
      }
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = undefined; }
      const read = readD1ExportAnswer(response.status, body, bookmark);
      if (read.kind === 'refused-login' && attempt === 0) {
        context.login.refused(used);
        continue;
      }
      return read;
    }
  };

  /** Poll `record`'s export until it ends or its bound passes, keeping the record current with every answer. */
  const follow = async (record: ExportRecord): Promise<{ record: ExportRecord; ended: Extract<D1ExportReading, { kind: 'complete' | 'ended' }> }> => {
    let current = record;
    for (;;) {
      let read: D1ExportReading | undefined;
      for (let attempt = 1; ; attempt += 1) {
        read = await ask(current.tables, current.bookmark);
        if (read.kind === 'running' || read.kind === 'complete' || read.kind === 'ended') break;
        // Nothing here ends the export: it stays recorded, and is asked after again.
        if (attempt >= D1_EXPORT_POLL_ATTEMPTS) {
          const detail = read.kind === 'refused-login' ? `HTTP ${read.status}: Cloudflare refused the operator's login` : read.detail;
          throw new ObjectReadError(`the D1 export at bookmark ${current.bookmark} was asked after ${attempt} times without an answer that settles it `
            + `(${redacted(detail)}); it stays recorded, and nothing starts another while it may run`, { transient: read.kind === 'unknown' && read.transient });
        }
        await sleep(pollMs);
      }
      current = { ...current, bookmark: read.kind === 'running' ? read.bookmark : current.bookmark, lastPolledAt: now() };
      writeRecord(file, current);
      if (read.kind !== 'running') return { record: current, ended: read };
      const elapsed = now() - current.startedAt;
      if (elapsed >= boundMs) throw new D1ExportUnfinished(current, elapsed, file, marginMs);
      await sleep(pollMs);
    }
  };

  const download = async (signedUrl: string): Promise<void> => {
    // The signed URL is a capability of its own, fetched with no operator credential, and never written to a message.
    let response: Response;
    try {
      response = await fetchApi(signedUrl, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(D1_EXPORT_REQUEST_MS * 10) });
    } catch (error) {
      throw new ObjectReadError(`the D1 export download did not reach Cloudflare (${redacted((error as Error).message)})`, { transient: true, cause: error });
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new ObjectReadError(`the D1 export download failed (HTTP ${response.status})`, { transient: response.status === 408 || response.status === 429 || response.status >= 500 || [403, 404, 410].includes(response.status) });
    }
    try {
      fs.writeFileSync(context.output, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
    } catch (error) {
      throw new ObjectReadError(`the D1 export download stopped before it arrived: ${redacted((error as Error).message)}`, { transient: true, cause: error });
    }
  };

  /** Resolve the export this machine has recorded, if any; see `settleD1Export`. */
  const settle = async (): Promise<SettledExport | null> => {
    let recorded = readRecord(file, marginMs);
    if (recorded === null) return null;
    if (now() - recorded.lastPolledAt >= marginMs) {
      // Asked after once more where it can be: one still running is followed, and only one Cloudflare says ended, or
      // no longer answers for, is taken to run no longer.
      const read = recorded.bookmark === null ? null : await ask(recorded.tables, recorded.bookmark);
      if (read?.kind !== 'running') {
        context.report?.(`The D1 export this machine recorded ${iso(recorded.startedAt)} was last answered for ${iso(recorded.lastPolledAt)}, `
          + `over ${Math.round(marginMs / 60_000)} min ago; Cloudflare no longer runs it, so its record is cleared`);
        fs.rmSync(file, { force: true });
        return null;
      }
      recorded = { ...recorded, bookmark: read.bookmark, lastPolledAt: now() };
      writeRecord(file, recorded);
    }
    if (recorded.bookmark === null) throw new D1ExportUnsettled(recorded, 'the answer to that request was lost', marginMs);
    context.report?.(`Resuming the D1 export this machine started ${iso(recorded.startedAt)} before starting another`);
    const { record, ended } = await follow(recorded);
    // Its result is a snapshot only while it is recent enough to be one; the caller holds it to the schema it reads.
    if (ended.kind === 'complete' && now() - record.startedAt < boundMs) {
      await download(ended.signedUrl);
      fs.rmSync(file, { force: true });
      return { schema: record.schema, startedAt: record.startedAt };
    }
    context.report?.(ended.kind === 'ended'
      ? `The D1 export this machine started ${iso(record.startedAt)} ended without a result (${redacted(ended.detail)})`
      : `The D1 export this machine started ${iso(record.startedAt)} completed past its bound, so its result is not used`);
    fs.rmSync(file, { force: true });
    return null;
  };

  /** Start one export and drive it to its result, recorded before its request is sent. */
  const start = async (tables: readonly string[], schema: string): Promise<void> => {
    if (fs.existsSync(file)) throw new Error(`a D1 export is still recorded at ${file}; it is settled before another starts`);
    let intent: ExportRecord = { databaseId: context.databaseId, tables: [...tables], bookmark: null, startedAt: now(), lastPolledAt: now(), schema };
    writeRecord(file, intent);
    // A refused credential started nothing, so the refreshed request is a new start with its own record.
    let first: D1ExportReading;
    try {
      first = await ask(tables, null, () => { intent = { ...intent, startedAt: now(), lastPolledAt: now() }; writeRecord(file, intent); });
    } catch (error) {
      // Only the login throws here, before its request is sent, and the one before it was refused: nothing started.
      fs.rmSync(file, { force: true });
      throw error;
    }
    if (first.kind === 'refused-login') {
      fs.rmSync(file, { force: true });
      throw new ObjectReadError(`Cloudflare refused the operator's login for the D1 export (HTTP ${first.status}); run wrangler login, then back up again`, { transient: false });
    }
    if (first.kind === 'unknown') throw new D1ExportUnsettled(intent, first.detail, marginMs);
    if (first.kind === 'ended') {
      fs.rmSync(file, { force: true });
      throw new D1ExportFailed(first.detail);
    }
    let ended: Extract<D1ExportReading, { kind: 'complete' | 'ended' }>;
    if (first.kind === 'complete') {
      // Recorded by its bookmark before its download, so a download that fails leaves an export the next backup
      // resumes; one that answers no bookmark completed and runs no longer, and is recorded as nothing.
      if (first.bookmark === null) fs.rmSync(file, { force: true });
      else writeRecord(file, { ...intent, bookmark: first.bookmark, lastPolledAt: now() });
      ended = first;
    } else {
      const running: ExportRecord = { ...intent, bookmark: first.bookmark, lastPolledAt: now() };
      writeRecord(file, running);
      await sleep(pollMs);
      ended = (await follow(running)).ended;
    }
    if (ended.kind === 'ended') {
      fs.rmSync(file, { force: true });
      throw new D1ExportFailed(ended.detail);
    }
    await download(ended.signedUrl);
    fs.rmSync(file, { force: true });
  };

  return { settle, start, file };
}

/**
 * Settle the export this machine has recorded against the database, before anything reads the database: a running
 * export pauses that read. Answers the recorded export where it completed inside its bound, its SQL written to
 * `output`, and null where there is none to use. Throws `D1ExportUnsettled` for an export whose start was never
 * answered and may still run, `D1ExportUnfinished` for one still running past its bound, and a transient
 * `ObjectReadError` where Cloudflare did not answer for it; each leaves the export recorded.
 */
export async function settleD1Export(context: D1ExportContext): Promise<SettledExport | null> {
  return exporter(context).settle();
}

/**
 * Export `tables` to `output`, never beside another export this machine may have running, and within the bound.
 * Takes the settled export's result where it was taken under `schema`; otherwise starts one. Throws
 * `D1ExportUnsettled` where the starting request had no answer that says whether it started, `D1ExportUnfinished`
 * when the export outlives its bound, `D1ExportFailed` when Cloudflare ends it without a result, and a transient
 * `ObjectReadError` for a poll or download that did not land; the export stays recorded through all but the third.
 */
export async function exportD1(options: D1ExportOptions): Promise<void> {
  const steps = exporter(options);
  const settled = options.settled !== undefined ? options.settled : await steps.settle();
  if (settled !== null) {
    if (settled.schema === options.schema) return;
    options.report?.('The resumed D1 export was taken under another schema, so it is discarded and a new one started');
    fs.rmSync(options.output, { force: true });
  }
  await steps.start(options.tables, options.schema);
}
