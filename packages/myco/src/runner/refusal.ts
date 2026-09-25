/**
 * The last refusal that ended a worker, kept per Deployment under the member
 * home.
 *
 * A refusal that repeats identically on every later request — a membership that
 * does not administer the Deployment, a credential the Deployment no longer
 * holds, a membership this home no longer has — ends the worker without a
 * restart. The record is what then says why no worker runs, to `worker status`
 * and `myco doctor`, and what keeps a later install from starting one the
 * Deployment will refuse again. A worker that is admitted clears it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { deploymentKeyFor, deploymentUrl } from '../member/registry.js';

/** The refusals no restart changes: each needs a person to act first. */
export const TERMINAL_REFUSALS = ['not_admin', 'unauthorized', 'no_membership'] as const;
export type TerminalRefusal = (typeof TERMINAL_REFUSALS)[number];

export const isTerminalRefusal = (code: string | null): code is TerminalRefusal =>
  code !== null && (TERMINAL_REFUSALS as readonly string[]).includes(code);

export interface WorkerRefusalRecord {
  serverUrl: string;
  code: TerminalRefusal;
  at: number;
}

export function workerRefusalPath(mycoHome: string, serverUrl: string): string {
  return path.join(mycoHome, 'worker', 'refusals', `${deploymentKeyFor(serverUrl)}.json`);
}

export function recordWorkerRefusal(mycoHome: string, serverUrl: string, code: TerminalRefusal, at: number): void {
  const file = workerRefusalPath(mycoHome, serverUrl);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const record: WorkerRefusalRecord = { serverUrl: deploymentUrl(serverUrl), code, at };
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** The recorded refusal, or null when there is none or it cannot be read as one. */
export function readWorkerRefusal(mycoHome: string, serverUrl: string): WorkerRefusalRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(workerRefusalPath(mycoHome, serverUrl), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const record = parsed as Partial<WorkerRefusalRecord>;
  if (typeof record.code !== 'string' || !isTerminalRefusal(record.code) || typeof record.at !== 'number') return null;
  return { serverUrl: deploymentUrl(serverUrl), code: record.code, at: record.at };
}

export function clearWorkerRefusal(mycoHome: string, serverUrl: string): void {
  fs.rmSync(workerRefusalPath(mycoHome, serverUrl), { force: true });
}
