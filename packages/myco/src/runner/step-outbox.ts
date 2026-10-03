/**
 * The worker's step-log outbox: each attempt's log, held on disk until the Deployment has every page.
 *
 * A run's step log is written here before the run's scratch directory is removed, as the exact request bodies its
 * pages travel in, so a worker stopped before it delivered them sends the same bytes when it starts again. One file
 * per attempt, under a directory of the Deployment it belongs to, written whole through the member store's atomic
 * private write; delivery records each page the Deployment acknowledged in the same file, so a page is sent again only
 * when its acknowledgement never arrived, and the Deployment keeps one copy of each step whatever it is sent. A file
 * is removed once every page is acknowledged, or once the Deployment answers a page with a refusal; a page the
 * Deployment does not answer — a transport failure, a 5xx or a 429 — leaves the file for the next pass.
 *
 * Every pass sweeps the whole outbox, every Deployment's directory whether or not that Deployment is still attached or
 * still takes step logs (`sweepStepOutbox`): a file older than `STEP_OUTBOX_RETENTION_MS` is removed, and while the
 * outbox holds more than `STEP_OUTBOX_MAX_BYTES` its oldest files are removed first.
 */
import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
const { mkdirSync, readdirSync, rmdirSync, rmSync, statSync } = nodeFs;
import { join } from 'node:path';
import { stepPages, type UnrecognizedCount, type WorkerStep } from '@goondocks/myco-shared/worker-steps';
import { readPrivateJson, writePrivateFileAtomic } from '../member/store.js';

/** The outbox directory's name inside a worker's run root, where no caller names another. */
export const STEP_OUTBOX_DIRNAME = '.steps';
/** How long an undelivered log waits for its Deployment before it is removed. */
export const STEP_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** The most bytes the whole outbox holds; past it, its oldest files are removed first. */
export const STEP_OUTBOX_MAX_BYTES = 64 * 1024 * 1024;
const OUTBOX_VERSION = 1;
const NAME_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;
const ENTRY_SUFFIX = '.steps.json';

export interface StepOutboxEntry {
  v: typeof OUTBOX_VERSION;
  serverUrl: string;
  projectId: string;
  runId: string;
  attemptId: string;
  createdAt: number;
  /** How many pages, from the first, the Deployment has acknowledged. */
  acked: number;
  /** Each page's request body, exactly as it is sent. */
  pages: string[];
}

/** What sending one page came to: stored, worth sending again later, or refused for good. */
export type PageDelivery = 'acked' | 'retry' | 'refused';

/** The directory one Deployment's outbox lives in. */
export function outboxDir(root: string, serverUrl: string): string {
  return join(root, createHash('sha256').update(serverUrl).digest('hex').slice(0, 16));
}

/** Write an attempt's log to the outbox, before anything of the run's scratch directory is removed. Answers the file. */
export function writeStepOutbox(root: string, input: {
  serverUrl: string; projectId: string; runId: string; attemptId: string; createdAt: number;
  steps: readonly WorkerStep[]; overflow: number; unrecognized: UnrecognizedCount;
}): string {
  if (!NAME_SHAPE.test(input.runId) || !NAME_SHAPE.test(input.attemptId)) throw new Error('Invalid step log identity.');
  const dir = outboxDir(root, input.serverUrl);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pages = stepPages(input.attemptId, input.steps, input.overflow, input.unrecognized)
    .map((page) => JSON.stringify({ projectId: input.projectId, runId: input.runId, ...page }));
  const entry: StepOutboxEntry = {
    v: OUTBOX_VERSION, serverUrl: input.serverUrl, projectId: input.projectId, runId: input.runId, attemptId: input.attemptId,
    createdAt: input.createdAt, acked: 0, pages,
  };
  const file = join(dir, `${input.runId}.${input.attemptId}${ENTRY_SUFFIX}`);
  writePrivateFileAtomic(file, JSON.stringify(entry));
  return file;
}

const isEntry = (value: unknown): value is StepOutboxEntry => {
  const entry = value as Partial<StepOutboxEntry> | null;
  return entry !== null && typeof entry === 'object' && entry.v === OUTBOX_VERSION && typeof entry.serverUrl === 'string'
    && typeof entry.createdAt === 'number' && typeof entry.acked === 'number' && Array.isArray(entry.pages)
    && entry.pages.every((page) => typeof page === 'string');
};

/** Remove this Deployment's outbox directory, and the outbox root, where nothing waits in them. */
export function removeEmptyOutbox(root: string, serverUrl: string): void {
  for (const dir of [outboxDir(root, serverUrl), root]) {
    try {
      rmdirSync(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
    }
  }
}

/** Every log waiting for this Deployment, oldest first; a file that cannot be read as one is named in the log and removed. */
export function pendingStepOutboxes(root: string, serverUrl: string, log: (line: string) => void): string[] {
  const dir = outboxDir(root, serverUrl);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(ENTRY_SUFFIX));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: { file: string; createdAt: number }[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const read = readPrivateJson<unknown>(file);
    if (!read.ok || !isEntry(read.value) || read.value.serverUrl !== serverUrl) {
      log(`removing a step log this worker cannot read (${read.ok ? 'not a step log' : read.reason}): ${name}`);
      rmSync(file, { force: true });
      continue;
    }
    files.push({ file, createdAt: read.value.createdAt });
  }
  return files.sort((a, b) => a.createdAt - b.createdAt).map(({ file }) => file);
}

/**
 * Send one log's pages that the Deployment has not acknowledged, in order, recording each acknowledgement. Answers
 * `delivered` once every page is acknowledged (the file is removed), `pending` when a page should be sent again later,
 * and `dropped` when the Deployment refused a page for good or the log outwaited its retention (the file is removed).
 */
export async function deliverStepOutbox(
  file: string, now: number, send: (body: string) => Promise<PageDelivery>, log: (line: string) => void,
): Promise<'delivered' | 'pending' | 'dropped'> {
  const read = readPrivateJson<unknown>(file);
  if (!read.ok || !isEntry(read.value)) { rmSync(file, { force: true }); return 'dropped'; }
  const entry = read.value;
  if (now - entry.createdAt > STEP_OUTBOX_RETENTION_MS) {
    log(`the step log of ${entry.runId} waited past its retention without reaching the Deployment; removing it`);
    rmSync(file, { force: true });
    return 'dropped';
  }
  for (let page = entry.acked; page < entry.pages.length; page += 1) {
    const sent = await send(entry.pages[page]!);
    if (sent === 'retry') return 'pending';
    if (sent === 'refused') {
      log(`the Deployment refused the step log of ${entry.runId}; removing it`);
      rmSync(file, { force: true });
      return 'dropped';
    }
    entry.acked = page + 1;
    if (entry.acked < entry.pages.length) writePrivateFileAtomic(file, JSON.stringify(entry));
  }
  rmSync(file, { force: true });
  return 'delivered';
}

/** Whether an error says the path is not there. */
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Sweep every Deployment's directory under `root`: remove each log past its retention or unreadable as a log, then,
 * while what is left holds more than `maxBytes`, the oldest logs first; and every directory left empty. Answers the count of
 * logs it removes.
 */
export function sweepStepOutbox(root: string, now: number, log: (line: string) => void, maxBytes = STEP_OUTBOX_MAX_BYTES): number {
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  } catch (error) {
    if (absent(error)) return 0;
    throw error;
  }
  const kept: { file: string; createdAt: number; bytes: number }[] = [];
  let removed = 0;
  for (const dir of dirs) {
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith(ENTRY_SUFFIX))) {
      const file = join(dir, name);
      const read = readPrivateJson<unknown>(file);
      const expired = read.ok && isEntry(read.value) && now - read.value.createdAt > STEP_OUTBOX_RETENTION_MS;
      if (!read.ok || !isEntry(read.value) || expired) {
        log(expired ? `the step log ${name} waited past its retention without reaching its Deployment; removing it` : `removing a step log this worker cannot read: ${name}`);
        rmSync(file, { force: true });
        removed += 1;
        continue;
      }
      kept.push({ file, createdAt: read.value.createdAt, bytes: statSync(file).size });
    }
  }
  let total = kept.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of kept.sort((a, b) => a.createdAt - b.createdAt)) {
    if (total <= maxBytes) break;
    log(`the step outbox holds more than ${maxBytes} bytes; removing its oldest log ${entry.file}`);
    rmSync(entry.file, { force: true });
    total -= entry.bytes;
    removed += 1;
  }
  for (const dir of [...dirs, root]) {
    try { rmdirSync(dir); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
    }
  }
  return removed;
}
