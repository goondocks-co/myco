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
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readD1ExportAnswer, type D1ExportReading } from '@goondocks/myco-shared/d1-export';
import { ObjectReadError, transientApiCode, transientStatus } from './object-read.js';
import type { CloudflareFetch, OperatorLogin } from './cloudflare.js';
import { fetchD1Download } from './d1-download.js';

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
/** How long one poll may wait for Cloudflare to begin answering. */
const D1_EXPORT_REQUEST_MS = 60_000;
/**
 * How long the download may go without a byte arriving before this attempt at it ends. It bounds a stall, never the
 * download's length: an export's SQL runs to hundreds of megabytes, and a total bound fails a large one that is still
 * arriving.
 */
export const D1_EXPORT_STALL_MS = 60_000;
/**
 * How many times one export's result is fetched before the backup gives it up. Each attempt after the first asks after
 * the same export for its download again, and resumes the bytes already on disk where the download serves a range.
 */
export const D1_EXPORT_DOWNLOAD_ATTEMPTS = 4;
/** New whole exports admitted under one recovery hold, including process and snapshot retries. */
export const D1_EXPORT_START_LIMIT = 2;

type AdmissionContext = Pick<D1ExportContext, 'accountId' | 'databaseId' | 'recordDir' | 'holdToken'>;
const admissionSchema = z.object({ accountId: z.string(), databaseId: z.string(), holdToken: z.string(),
  started: z.number().int().min(0).max(D1_EXPORT_START_LIMIT) });
type AdmissionRecord = z.infer<typeof admissionSchema>;

const admissionPath = (recordDir: string, databaseId: string, holdToken: string) => path.join(recordDir,
  `d1-admissions-${createHash('sha256').update(JSON.stringify([databaseId, holdToken])).digest('hex')}.json`);

/** One admission writer; held captures persist every start before its request, and bookmark polls consume none. */
export class D1ExportStartBudget {
  private started = 0;

  /** Initializes a newly acquired hold's budget; an existing budget is never reset. */
  constructor(freshHold?: AdmissionContext) {
    if (freshHold?.holdToken && this.read(freshHold) === null) this.write(freshHold, 0);
  }

  private read(context: AdmissionContext): number | null {
    if (!context.holdToken) return this.started;
    let raw: string;
    try { raw = fs.readFileSync(admissionPath(context.recordDir, context.databaseId, context.holdToken), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const record = admissionSchema.parse(JSON.parse(raw));
    if (record.accountId !== context.accountId || record.databaseId !== context.databaseId || record.holdToken !== context.holdToken) {
      throw new Error('D1 export admission record belongs to another recovery hold or source');
    }
    return record.started;
  }

  private write(context: AdmissionContext, started: number): void {
    if (!context.holdToken) { this.started = started; return; }
    writeRecord(admissionPath(context.recordDir, context.databaseId, context.holdToken),
      { accountId: context.accountId, databaseId: context.databaseId, holdToken: context.holdToken, started });
  }

  admit(context: AdmissionContext): () => void {
    const started = this.read(context);
    if (started === null) throw new Error('D1 export admission count is unavailable for this recovery hold; no new export was started. '
      + 'Resume its recorded export, or explicitly abandon the hold before starting a new recovery attempt.');
    if (started >= D1_EXPORT_START_LIMIT) {
      throw new Error(`new D1 export limit (${D1_EXPORT_START_LIMIT}) reached for this recovery attempt; no further export was started. `
        + 'Each new export pauses D1 queries. Resume its recorded export, or explicitly abandon this recovery hold before starting a new recovery attempt.');
    }
    this.write(context, started + 1);
    let refused = false;
    return () => {
      if (refused) return;
      const current = this.read(context);
      if (current === null || current < 1) throw new Error('D1 export admission count is unavailable for authentication-refusal refund');
      this.write(context, current - 1);
      refused = true;
    };
  }

  /** A confirmed released hold ends its admission budget, independently of any kept export record. */
  static release(recordDir: string, databaseId: string, holdToken: string): void {
    fs.rmSync(admissionPath(recordDir, databaseId, holdToken), { force: true });
  }
}

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
  /**
   * The export ended and its SQL is whole at the output: nothing runs, and the result is kept until the snapshot built
   * from it is saved (`releaseD1Export`), so a step that fails after the download is tried again without exporting.
   */
  downloaded: z.boolean().optional(),
  /** The size and SHA-256 of the SQL as it was downloaded; a kept result is taken again only while it still matches. */
  result: z.object({ bytes: z.number(), sha256: z.string() }).optional(),
  /** The recovery hold the export was taken under: its SQL is a snapshot only for a capture under that same hold. */
  holdToken: z.string().nullable().optional(),
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
  /** Shared across the snapshot retries of one backup run. */
  startBudget?: D1ExportStartBudget;
  fetch?: CloudflareFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test-only overrides of the bound, the cancel margin, the pause between polls and the download's stall. */
  boundMs?: number;
  marginMs?: number;
  pollMs?: number;
  stallMs?: number;
  report?: (line: string) => void;
  /** The recovery hold the capture runs under, which a kept result must have been taken under to be taken again. */
  holdToken?: string | null;
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
export interface SettledExport { schema: string; startedAt: number; holdToken: string | null }

/** Where the export running against `databaseId` is recorded. */
export function exportRecordPath(recordDir: string, databaseId: string): string {
  return path.join(recordDir, `d1-export-${databaseId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

/** Where the SQL of the export against `databaseId` is kept beside its record, outlasting the attempt that downloaded it. */
export function exportResultPath(recordDir: string, databaseId: string): string {
  return exportRecordPath(recordDir, databaseId).replace(/\.json$/, '.sql');
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
function writeRecord(file: string, record: ExportRecord | AdmissionRecord): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

/** The size and SHA-256 of a file, read through once. */
async function digestOf(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) {
    bytes += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  return { bytes, sha256: hash.digest('hex') };
}

/** Flush `file` and the directory that names it, so a rename that follows publishes whole bytes. */
function syncPath(file: string): void {
  const handle = fs.openSync(file, 'r');
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

/** The steps of one export, over one context. */
function exporter(context: D1ExportContext) {
  const fetchApi = context.fetch ?? globalThis.fetch;
  const fetchDownload = context.fetch ?? fetchD1Download;
  const now = context.now ?? Date.now;
  const sleep = context.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const boundMs = context.boundMs ?? D1_EXPORT_BOUND_MS;
  const marginMs = context.marginMs ?? D1_EXPORT_CANCEL_MARGIN_MS;
  const pollMs = context.pollMs ?? D1_EXPORT_POLL_MS;
  const stallMs = context.stallMs ?? D1_EXPORT_STALL_MS;
  const startBudget = context.startBudget ?? new D1ExportStartBudget();
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
      const refusedStart = bookmark === null ? startBudget.admit(context) : () => {};
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
      if (read.kind === 'refused-login') refusedStart();
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

  /**
   * One attempt at the download, streamed to `part` and bounded by a stall rather than a total: it ends only where no
   * byte arrives for `stallMs`. Bytes already in `part` are resumed where the download serves exactly the range asked
   * for, of the object the first answer described (`served`: its ETag and length, sent back as `If-Range`), and
   * rewritten from the start otherwise, never spliced. Null once the whole result is in `part`.
   */
  const downloadOnce = async (signedUrl: string, part: string, served: { etag: string | null; total: number | null }): Promise<null | { error: ObjectReadError; gone: boolean }> => {
    let offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
    const strong = (etag: string | null): etag is string => etag !== null && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag);
    if (offset > 0 && (!strong(served.etag) || served.total === null)) {
      fs.rmSync(part, { force: true });
      offset = 0;
    }
    const controller = new AbortController();
    const waiting = async <T>(operation: () => Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<T>((resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`no bytes arrived for ${Math.round(stallMs / 1000)} s`));
            controller.abort();
          }, stallMs);
          operation().then(resolve, reject);
        });
      } finally { clearTimeout(timer); }
    };
    const failed = (message: string, gone = false, transient = true) => ({ error: new ObjectReadError(message, { transient }), gone });
    try {
      // The signed URL is a capability of its own, fetched with no operator credential, and never written to a message.
      let response: Response;
      try {
        // Asked for as stored, so a length and a range count the bytes written here.
        const headers = new Headers({ 'accept-encoding': 'identity' });
        if (offset > 0) {
          headers.set('range', `bytes=${offset}-`);
          if (served.etag !== null) headers.set('if-range', served.etag);
        }
        response = await waiting(() => fetchDownload(signedUrl, { method: 'GET', redirect: 'follow', signal: controller.signal, headers }));
      } catch (error) {
        return failed(`the D1 export download did not reach Cloudflare (${redacted((error as Error).message)})`);
      }
      if ([401, 403, 404, 410].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        return failed(`the D1 export download is no longer served (HTTP ${response.status})`, true);
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel().catch(() => {});
        return failed(`the D1 export download failed (HTTP ${response.status})`, false, response.status === 408 || response.status === 429 || response.status >= 500);
      }
      // An answer served encoded anyway counts its length and ranges in bytes this side never sees: it is taken whole,
      // with no length to hold it to, and never resumed or appended to.
      const encoded = !['identity', ''].includes((response.headers.get('content-encoding') ?? '').trim().toLowerCase());
      const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      const etag = response.headers.get('etag');
      let resumed = false;
      if (response.status === 206) {
        const same = offset > 0 && !encoded && range !== null && Number(range[1]) === offset
          && served.total !== null && Number(range[2]) === served.total
          && strong(served.etag) && strong(etag) && etag === served.etag;
        if (!same) {
          await response.body.cancel().catch(() => {});
          fs.rmSync(part, { force: true });
          return failed('the D1 export download answered a range other than the one asked for, or of another object; it starts again from its first byte');
        }
        resumed = true;
      }
      const declared = encoded ? Number.NaN : resumed ? Number(range![2]) : Number(response.headers.get('content-length') ?? Number.NaN);
      // A whole answer is told from a cut one by the length it declares; one that declares none is never taken.
      if (!encoded && !Number.isFinite(declared)) {
        await response.body.cancel().catch(() => {});
        fs.rmSync(part, { force: true });
        return failed('the D1 export download declared no length, so a whole answer cannot be told from a cut one');
      }
      if (!resumed) {
        served.etag = etag;
        served.total = encoded ? null : declared;
      }
      const handle = fs.openSync(part, resumed ? 'a' : 'w', 0o600);
      let written = resumed ? offset : 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await waiting(() => reader.read());
          if (chunk.done) break;
          let offset = 0;
          while (offset < chunk.value.byteLength) {
            const written = fs.writeSync(handle, chunk.value, offset, chunk.value.byteLength - offset);
            if (written === 0) throw new Error('D1 export file write made no progress');
            offset += written;
          }
          written += chunk.value.byteLength;
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        if (encoded) fs.rmSync(part, { force: true });
        return failed(`the D1 export download stopped before it arrived: ${redacted((error as Error).message)}`);
      } finally {
        fs.closeSync(handle);
      }
      if (Number.isFinite(declared) && written !== declared) return failed(`the D1 export download ended at ${written} of ${declared} bytes`);
      return null;
    } finally {
      controller.abort();
    }
  };

  /**
   * Fetch the result of the export `bookmark` names to the output. A download that stops is fetched again, resuming its
   * bytes, and before each retry the same export is asked after for its download, so a signed URL that lapsed is
   * replaced: never by a new export. A download Cloudflare no longer serves, for an export that names no other, is the
   * result lost: the export ended, so its record is cleared and the next backup starts one.
   */
  const download = async (tables: readonly string[], bookmark: string | null, signedUrl: string): Promise<{ bytes: number; sha256: string }> => {
    const part = `${context.output}.part`;
    fs.rmSync(part, { force: true });
    let url = signedUrl;
    const served: { etag: string | null; total: number | null } = { etag: null, total: null };
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await downloadOnce(url, part, served);
      if (outcome === null) {
        syncPath(part);
        fs.renameSync(part, context.output);
        syncPath(path.dirname(context.output));
        return digestOf(context.output);
      }
      if (!outcome.error.transient || attempt >= D1_EXPORT_DOWNLOAD_ATTEMPTS) {
        fs.rmSync(part, { force: true });
        throw outcome.error;
      }
      context.report?.(`${outcome.error.message}; asking after the same D1 export for its download again (attempt ${attempt + 1} of ${D1_EXPORT_DOWNLOAD_ATTEMPTS})`);
      const read = bookmark === null ? null : await ask(tables, bookmark);
      if (read?.kind === 'complete') url = read.signedUrl;
      else if (outcome.gone && (read?.kind === 'running' || read?.kind === 'refused-login')) {
        // The export is reported running, or the answer settles nothing about it: it stays recorded, and nothing
        // starts another beside it; the next attempt resumes it.
        fs.rmSync(part, { force: true });
        throw new ObjectReadError(`the D1 export's download is no longer served, and Cloudflare ${read.kind === 'running' ? 'reports that export still running' : 'refused the operator\'s login when asked after it'}; `
          + 'it stays recorded, and the next attempt resumes it rather than starting another', { transient: true });
      } else if (outcome.gone) {
        fs.rmSync(part, { force: true });
        fs.rmSync(file, { force: true });
        throw new ObjectReadError(`the D1 export's result is no longer served and Cloudflare names no other (${redacted(read === null ? 'the export answered no bookmark' : read.kind === 'ended' ? read.detail : read.kind)}); `
          + 'the export ended, so its record is cleared and the next attempt starts one', { transient: true });
      }
      await sleep(pollMs);
    }
  };

  /** Resolve the export this machine has recorded, if any; see `settleD1Export`. */
  const settle = async (): Promise<SettledExport | null> => {
    let recorded = readRecord(file, marginMs);
    if (recorded === null) return null;
    if (recorded.downloaded === true) {
      // An export that ended with its SQL downloaded runs no longer: its result is taken again while it is recent enough
      // to be this snapshot, and nothing is asked of Cloudflare.
      if (now() - recorded.startedAt < boundMs) {
        const held = fs.existsSync(context.output) ? await digestOf(context.output) : null;
        if (held !== null && recorded.result !== undefined && held.bytes === recorded.result.bytes && held.sha256 === recorded.result.sha256) {
          context.report?.(`Taking the D1 export this machine downloaded ${iso(recorded.startedAt)} again rather than exporting another`);
          return { schema: recorded.schema, startedAt: recorded.startedAt, holdToken: recorded.holdToken ?? null };
        }
        context.report?.(`The D1 export this machine downloaded ${iso(recorded.startedAt)} is no longer whole as downloaded, so it is discarded`);
      }
      fs.rmSync(file, { force: true });
      fs.rmSync(context.output, { force: true });
      return null;
    }
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
      const result = await download(record.tables, record.bookmark, ended.signedUrl);
      writeRecord(file, { ...record, downloaded: true, result, lastPolledAt: now() });
      return { schema: record.schema, startedAt: record.startedAt, holdToken: record.holdToken ?? null };
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
    let intent: ExportRecord = { databaseId: context.databaseId, tables: [...tables], bookmark: null, startedAt: now(), lastPolledAt: now(), schema, holdToken: context.holdToken ?? null };
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
    const result = await download(tables, ended.bookmark, ended.signedUrl);
    writeRecord(file, { ...intent, bookmark: ended.bookmark, downloaded: true, result, lastPolledAt: now() });
  };

  /** Give up the result this machine holds: the record and the SQL it names. */
  const release = (): void => {
    fs.rmSync(file, { force: true });
    fs.rmSync(context.output, { force: true });
  };

  return { settle, start, release, file };
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
    const otherHold = options.holdToken !== undefined && settled.holdToken !== options.holdToken;
    if (settled.schema === options.schema && !otherHold) return;
    options.report?.(otherHold
      ? 'The D1 export this machine holds was taken under another recovery hold, so it is discarded and a new one started under this one'
      : 'The resumed D1 export was taken under another schema, so it is discarded and a new one started');
    steps.release();
  }
  await steps.start(options.tables, options.schema);
}

/**
 * Give up the export result this machine holds for the database, once the snapshot built from it is saved: the record
 * and the SQL. Until then a retry takes the result again rather than exporting.
 */
export function releaseD1Export(context: D1ExportContext): void {
  exporter(context).release();
}

/**
 * Give up the result this machine kept for the database under `holdToken`, once that hold is released: no capture
 * under it can use the result any longer. A result kept under another hold, and an export still running, stay.
 */
export function releaseKeptD1Export(recordDir: string, databaseId: string, holdToken: string): void {
  D1ExportStartBudget.release(recordDir, databaseId, holdToken);
  const file = exportRecordPath(recordDir, databaseId);
  let recorded: ExportRecord | null;
  try { recorded = readRecord(file, D1_EXPORT_CANCEL_MARGIN_MS); } catch { return; }
  if (recorded === null || recorded.downloaded !== true || recorded.holdToken !== holdToken) return;
  fs.rmSync(file, { force: true });
  fs.rmSync(exportResultPath(recordDir, databaseId), { force: true });
}

/** How many times one read of the database is sent, and the pause before each retry: `D1_QUERY_BACKOFF_MS[n]` precedes attempt n + 2. */
export const D1_QUERY_ATTEMPTS = 3;
export const D1_QUERY_BACKOFF_MS: readonly number[] = [2_000, 5_000];
/** How long one read may wait for its answer. */
const D1_QUERY_TIMEOUT_MS = 60_000;

/**
 * One read of the database, over the same API and the same operator login as the export, rather than a Wrangler
 * command with a login of its own: a backup reads and exports under one credential, refreshed in one place.
 *
 * A read that Cloudflare answers with a transient code — `7403` among them, which D1 answers for an account other
 * requests succeed with — is sent again, up to `D1_QUERY_ATTEMPTS`, and a refused login is refreshed once. What
 * remains is thrown as an `ObjectReadError` naming the codes, transient where a later attempt may still pass.
 */
/** What a read or statement over the D1 API needs from an export's context. */
export type D1QueryContext = Pick<D1ExportContext, 'accountId' | 'databaseId' | 'login' | 'fetch' | 'sleep' | 'report'>;

export async function queryD1(context: D1QueryContext, sql: string): Promise<unknown[]> {
  return (await queryD1Answer(context, sql)).results;
}

/** What one statement over the D1 API answered: its rows, and how many rows it changed. */
export interface D1Answer { results: unknown[]; changes: number }

/** One statement over the D1 API with its bound parameters (`queryD1`'s path, login and bounded retry), with its changed-row count. */
export async function queryD1Answer(context: D1QueryContext, sql: string, params: readonly unknown[] = []): Promise<D1Answer> {
  const fetchApi = context.fetch ?? globalThis.fetch;
  const sleep = context.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const endpoint = `${API_ORIGIN}/client/v4/accounts/${encodeURIComponent(context.accountId)}/d1/database/${encodeURIComponent(context.databaseId)}/query`;
  let refreshed = false;
  for (let attempt = 1; ; attempt += 1) {
    const used = context.login.current();
    const headers = new Headers(await used);
    headers.set('content-type', 'application/json');
    let failure: ObjectReadError;
    try {
      const response = await fetchApi(endpoint, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(D1_QUERY_TIMEOUT_MS), body: JSON.stringify(params.length === 0 ? { sql } : { sql, params }) });
      const text = await response.text();
      type Answer = { success?: unknown; errors?: unknown; result?: unknown };
      const body = ((): Answer | null => { try { return JSON.parse(text) as Answer; } catch { return null; } })();
      const codes = Array.isArray(body?.errors) ? body.errors.map((e) => String((e as { code?: unknown }).code ?? '')).filter((c) => c !== '') : [];
      const said = Array.isArray(body?.errors) ? body.errors.map((e) => String((e as { message?: unknown }).message ?? '')).filter((m) => m !== '').join('; ') : '';
      const first = Array.isArray(body?.result) ? body.result[0] as { success?: unknown; results?: unknown; meta?: { changes?: unknown } } | undefined : undefined;
      if (response.ok && body?.success === true && first?.success === true && Array.isArray(first.results)) {
        return { results: first.results, changes: typeof first.meta?.changes === 'number' ? first.meta.changes : 0 };
      }
      const refusedLogin = response.status === 401 || codes.includes('10000');
      if (refusedLogin && !refreshed) {
        refreshed = true;
        context.login.refused(used);
        attempt -= 1;
        continue;
      }
      const transient = !refusedLogin && (transientStatus(response.status) || codes.some((code) => transientApiCode(code)));
      failure = new ObjectReadError(`D1 did not answer the read (HTTP ${response.status}${codes.map((c) => ` [code: ${c}]`).join('')}${said === '' ? '' : `: ${redacted(said)}`})`,
        { transient, apiCodes: codes });
    } catch (error) {
      failure = new ObjectReadError(`the read did not reach D1 (${redacted((error as Error).message)})`, { transient: true, cause: error });
    }
    if (!failure.transient || attempt >= D1_QUERY_ATTEMPTS) throw failure;
    context.report?.(`${failure.message}; reading it again (attempt ${attempt + 1} of ${D1_QUERY_ATTEMPTS})`);
    await sleep(D1_QUERY_BACKOFF_MS[Math.min(attempt - 1, D1_QUERY_BACKOFF_MS.length - 1)] ?? 0);
  }
}
