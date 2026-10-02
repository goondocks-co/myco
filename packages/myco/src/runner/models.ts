/**
 * The models each harness a worker offers can run, listed the way its manifest says (`runner.worker.models`).
 *
 * One path lists every harness: a `command` whose output is one model id per line, or an `exchange` of JSON lines on
 * the harness's standard input and output whose answer holds the list. Nothing here names a harness. A listing runs in
 * a directory of its own, holds no credential the Deployment issued, and is stopped once it has answered or once
 * `MODEL_LISTING_TIMEOUT_MS` has passed, so a harness that never answers leaves no process behind.
 *
 * What a listing answers is normalized by the same rule the Deployment applies to a stored catalog
 * (`parseModelCatalog`): a model the harness's settings would refuse is not offered, and a list past the bound is cut.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseModelCatalog, type ModelCatalog } from '@goondocks/myco-shared/execution-profile';
import { harnessById, type ModelListing } from './harnesses.js';
import { recordOf } from './drivers/stream.js';

/** How long one harness's listing may take before it is stopped and reported as failed. */
export const MODEL_LISTING_TIMEOUT_MS = 30_000;

/** The most output a listing is read for; a harness writing more is stopped and its listing fails. */
const MAX_LISTING_OUTPUT_CHARS = 8 * 1024 * 1024;

/**
 * Every value at a dotted path: `a.b` reads key `b` of key `a`, and `a[].b` reads `b` of every entry of the list at
 * `a`. A step that finds nothing ends that branch.
 */
export function valuesAt(value: unknown, path: string): unknown[] {
  let current: unknown[] = [value];
  for (const step of path.split('.')) {
    const each = step.endsWith('[]');
    const key = each ? step.slice(0, -2) : step;
    current = current.flatMap((item) => {
      const next = recordOf(item)?.[key];
      if (next === undefined) return [];
      if (!each) return [next];
      return Array.isArray(next) ? next : [];
    });
  }
  return current;
}

const first = (value: unknown, path: string | undefined): unknown => (path === undefined ? undefined : valuesAt(value, path)[0]);

/** The facts of one listed entry, read through the manifest's fields, in the shape a catalog keeps. */
function entryOf(item: unknown, listing: Extract<ModelListing, { kind: 'exchange' }>): Record<string, unknown> {
  const { fields } = listing;
  const id = first(item, fields.id);
  const efforts = fields.efforts === undefined ? [] : valuesAt(item, fields.efforts).flatMap((v) => (Array.isArray(v) ? v : [v]));
  return {
    id, label: first(item, fields.label), isDefault: first(item, fields.isDefault),
    resolvesTo: first(item, fields.resolvesTo), upgrade: first(item, fields.upgrade), efforts,
    ...providerOf(id, listing.provider),
  };
}

const providerOf = (id: unknown, provider: ModelListing['provider']): { provider?: string } =>
  provider === 'id-prefix' && typeof id === 'string' && id.includes('/') ? { provider: id.slice(0, id.indexOf('/')) } : {};

/** Whether an answer holds every value `where` names. */
const answers = (message: unknown, where: Readonly<Record<string, string | number>>): boolean =>
  Object.entries(where).every(([path, expected]) => valuesAt(message, path).some((value) => value === expected));

/** What a listing process is given: where it runs and what bounds it. */
export interface ListingOptions { cwd: string; signal: AbortSignal; timeoutMs?: number }

/**
 * Run one listing and answer the raw entries it listed, or throw saying why it could not. The process is stopped once
 * it answers, on the timeout, or when `signal` aborts.
 */
export async function runListing(binary: string, listing: ModelListing, options: ListingOptions): Promise<Record<string, unknown>[]> {
  const child = spawn(binary, [...listing.args], {
    cwd: options.cwd,
    env: { ...process.env, ...listing.env },
    stdio: [listing.kind === 'exchange' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const stop = (): void => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  const deadline = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? MODEL_LISTING_TIMEOUT_MS)]);
  deadline.addEventListener('abort', stop, { once: true });
  let errors = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { if (errors.length < 2000) errors += chunk; });
  child.stdin?.on('error', () => undefined);
  try {
    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      let held = '';
      let read = 0;
      const lines: string[] = [];
      const fail = (reason: string): void => { reject(new Error(reason)); stop(); };
      const onLine = (line: string): void => {
        if (listing.kind === 'command') { lines.push(line); return; }
        let message: unknown;
        try { message = JSON.parse(line); } catch { return; }
        if (!answers(message, listing.answer.where)) return;
        const list = valuesAt(message, listing.answer.list)[0];
        if (!Array.isArray(list)) { fail(`its answer held no list at ${listing.answer.list}`); return; }
        resolve(list.map((item) => entryOf(item, listing)));
        stop();
      };
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        read += chunk.length;
        if (read > MAX_LISTING_OUTPUT_CHARS) { fail(`it wrote more than ${MAX_LISTING_OUTPUT_CHARS} characters`); return; }
        held += chunk;
        let at = held.indexOf('\n');
        while (at >= 0) {
          const line = held.slice(0, at).trim();
          held = held.slice(at + 1);
          if (line.length > 0) onLine(line);
          at = held.indexOf('\n');
        }
      });
      const expired = (): void => fail(options.signal.aborted ? 'the worker stopped' : `it did not answer within ${(options.timeoutMs ?? MODEL_LISTING_TIMEOUT_MS) / 1000}s`);
      if (deadline.aborted) expired();
      else deadline.addEventListener('abort', expired, { once: true });
      child.once('error', (error) => fail(`it could not be started: ${error.message}`));
      child.once('close', (code) => {
        if (held.trim().length > 0) onLine(held.trim());
        held = '';
        if (listing.kind === 'command' && code === 0) {
          resolve(lines.map((id) => ({ id, ...providerOf(id, listing.provider) })));
          return;
        }
        const said = errors.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        fail(`it exited ${code ?? 'on a signal'} without listing models${said === '' ? '' : `: ${said}`}`);
      });
      if (listing.kind === 'exchange') for (const message of listing.send) child.stdin?.write(`${JSON.stringify(message)}\n`);
    });
  } finally {
    deadline.removeEventListener('abort', stop);
    stop();
  }
}

/** The models one harness listed, as a catalog keeps them, or why it could not list them. */
export type HarnessListing = { ok: true; catalog: ModelCatalog } | { ok: false; harness: string; reason: string };

/** List one harness's models through its manifest's declaration, in a directory of the listing's own under `root`. */
export async function listHarnessModels(id: string, root: string, signal: AbortSignal, clock: () => number = Date.now): Promise<HarnessListing | null> {
  const harness = harnessById(id);
  if (harness?.models === undefined) return null;
  const listing = harness.models;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const cwd = mkdtempSync(join(root, 'models-'));
  try {
    const entries = await runListing(harness.binary, listing, { cwd, signal });
    const catalog = parseModelCatalog({
      harness: id, source: { kind: listing.kind, command: [harness.binary, ...listing.args].join(' ') }, fetchedAt: clock(), models: entries,
      truncated: false,
    });
    if (catalog === null) return { ok: false, harness: id, reason: 'its settings take no model, so it has none to list' };
    return { ok: true, catalog };
  } catch (error) {
    return { ok: false, harness: id, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Every listing of `harnesses` whose manifest declares one, each in turn: one harness's failure never stops another's. */
export async function listModels(harnesses: readonly string[], root: string, signal: AbortSignal, clock: () => number = Date.now): Promise<HarnessListing[]> {
  const out: HarnessListing[] = [];
  for (const id of harnesses) {
    if (signal.aborted) break;
    const listed = await listHarnessModels(id, root, signal, clock);
    if (listed !== null) out.push(listed);
  }
  return out;
}
