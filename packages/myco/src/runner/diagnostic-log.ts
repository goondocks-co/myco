/**
 * The worker's local diagnostics log: what a harness or the worker itself said about a run that failed.
 *
 * A run's record on the Deployment carries a coded reason alone (`run-text.ts` in myco-shared). The words behind it —
 * a harness's stderr, its in-band error, an exception the worker caught — are kept here, on the machine that ran the
 * run and nowhere else, for whoever operates that machine. Before an entry is written, every value of the run's
 * credential environment is masked where it appears verbatim, and known access-key shapes are masked
 * (`redactSecrets`). Each entry holds at most `MAX_ENTRY_CHARS` of words; the file is rotated into `.1` …
 * `.<MAX_BACKUPS>` before a write would take it past `MAX_LOG_BYTES`, the oldest dropped; a file whose newest entry is
 * older than `MAX_LOG_AGE_MS` is removed; and the file is written owner-only.
 */
import nodeFs from 'node:fs';
const { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } = nodeFs;
import { join } from 'node:path';
import { redactSecrets } from '@goondocks/myco-shared/redact-secrets';
import { WORKER_DIAGNOSTIC_LOG } from '@goondocks/myco-shared/worker-log';

export const DIAGNOSTIC_LOG_FILENAME = WORKER_DIAGNOSTIC_LOG.split('/').at(-1)!;
/** How many characters of a harness's or the worker's words one entry keeps. */
export const MAX_ENTRY_CHARS = 16 * 1024;
/** The size the live file never grows past. */
export const MAX_LOG_BYTES = 1024 * 1024;
/** How many rotated files are kept. */
export const MAX_BACKUPS = 2;
/** How long an entry is kept: a file whose newest entry is older than this is removed. */
export const MAX_LOG_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** The shortest credential value masked verbatim; a shorter one is no credential and masking it would mangle the words. */
const MIN_MASKED_CHARS = 4;

export interface DiagnosticEntry {
  runId: string;
  harness: string;
  /** The coded reason the run's record carries. */
  error: string;
  /** What the harness or the worker said. */
  detail: string;
}

export interface DiagnosticLogOptions {
  /** Values masked wherever they appear verbatim: the run's credential environment. */
  secrets?: readonly string[];
  maxBytes?: number;
  maxAgeMs?: number;
}

/** The live diagnostics log in this directory. */
export const diagnosticLogPath = (dir: string): string => join(dir, DIAGNOSTIC_LOG_FILENAME);

const filesOf = (dir: string): string[] => [diagnosticLogPath(dir), ...Array.from({ length: MAX_BACKUPS }, (_, i) => `${diagnosticLogPath(dir)}.${i + 1}`)];

/** Remove every file whose newest entry is older than the age bound. */
function prune(dir: string, now: number, maxAgeMs: number): void {
  for (const file of filesOf(dir)) {
    try {
      if (now - statSync(file).mtimeMs > maxAgeMs) rmSync(file, { force: true });
    } catch { /* a file that is not there needs no pruning */ }
  }
}

/** Rotate the live file where writing `bytes` more would take it past `maxBytes`. */
function rotate(dir: string, bytes: number, maxBytes: number): void {
  const live = diagnosticLogPath(dir);
  let size: number;
  try { size = statSync(live).size; } catch { return; }
  if (size + bytes <= maxBytes) return;
  for (let n = MAX_BACKUPS - 1; n >= 1; n -= 1) {
    if (existsSync(`${live}.${n}`)) renameSync(`${live}.${n}`, `${live}.${n + 1}`);
  }
  renameSync(live, `${live}.1`);
}

/** The words with every credential value masked where it appears verbatim, then known access-key shapes. */
export function maskedDetail(detail: string, secrets: readonly string[] = []): string {
  let masked = detail;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= MIN_MASKED_CHARS) masked = masked.replaceAll(secret, '[REDACTED]');
  }
  masked = redactSecrets(masked);
  return masked.length > MAX_ENTRY_CHARS ? `${masked.slice(0, MAX_ENTRY_CHARS)}…` : masked;
}

/** Append one entry as a line of JSON, stamped with its instant: pruned by age, rotated before it would cross the size bound. */
export function keepDiagnostic(dir: string, entry: DiagnosticEntry, now: number = Date.now(), options: DiagnosticLogOptions = {}): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  prune(dir, now, options.maxAgeMs ?? MAX_LOG_AGE_MS);
  const line = `${JSON.stringify({ at: new Date(now).toISOString(), ...entry, detail: maskedDetail(entry.detail, options.secrets) })}\n`;
  rotate(dir, Buffer.byteLength(line), options.maxBytes ?? MAX_LOG_BYTES);
  const path = diagnosticLogPath(dir);
  appendFileSync(path, line, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* a filesystem without modes keeps the entry */ }
}
