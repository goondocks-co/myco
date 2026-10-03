/**
 * The worker's local diagnostics log: what a harness or the worker itself said about a run that failed.
 *
 * A run's record on the Deployment carries a coded reason alone (`run-text.ts` in myco-shared). The words behind it —
 * a harness's stderr, its in-band error, an exception the worker caught — are kept here, on the machine that ran the
 * run and nowhere else, for whoever operates that machine. Each entry holds at most `MAX_ENTRY_CHARS` of words, the
 * file is rotated past `MAX_LOG_BYTES` into `.1` … `.<MAX_BACKUPS>`, the oldest dropped, and it is written owner-only.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DIAGNOSTIC_LOG_FILENAME = 'diagnostics.log';
/** How many characters of a harness's or the worker's words one entry keeps. */
export const MAX_ENTRY_CHARS = 16 * 1024;
/** The size past which the live file is rotated. */
export const MAX_LOG_BYTES = 1024 * 1024;
/** How many rotated files are kept. */
export const MAX_BACKUPS = 2;

export interface DiagnosticEntry {
  runId: string;
  harness: string;
  /** The coded reason the run's record carries. */
  error: string;
  /** What the harness or the worker said. */
  detail: string;
}

/** The live diagnostics log in this directory. */
export const diagnosticLogPath = (dir: string): string => join(dir, DIAGNOSTIC_LOG_FILENAME);

function rotate(dir: string, maxBytes: number): void {
  const live = diagnosticLogPath(dir);
  let size: number;
  try { size = statSync(live).size; } catch { return; }
  if (size <= maxBytes) return;
  for (let n = MAX_BACKUPS - 1; n >= 1; n -= 1) {
    if (existsSync(`${live}.${n}`)) renameSync(`${live}.${n}`, `${live}.${n + 1}`);
  }
  renameSync(live, `${live}.1`);
}

/** Append one entry as a line of JSON, stamped with its instant, rotating the file first where it has grown past its bound. */
export function keepDiagnostic(dir: string, entry: DiagnosticEntry, now: number = Date.now(), maxBytes: number = MAX_LOG_BYTES): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  rotate(dir, maxBytes);
  const detail = entry.detail.length > MAX_ENTRY_CHARS ? `${entry.detail.slice(0, MAX_ENTRY_CHARS)}…` : entry.detail;
  const path = diagnosticLogPath(dir);
  appendFileSync(path, `${JSON.stringify({ at: new Date(now).toISOString(), ...entry, detail })}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* a filesystem without modes keeps the entry */ }
}
