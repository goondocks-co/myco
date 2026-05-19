/**
 * JSON sentinel helpers — small JSON files that act as on-disk signals
 * between daemon processes (update in-flight, last update error, daemon
 * service state, etc.).
 *
 * Three sites historically reimplemented the same try/catch read +
 * idempotent unlink pattern (`daemon/update-in-progress.ts`,
 * `daemon/update-checker.ts`'s `readUpdateError`/`consumeUpdateError`,
 * `daemon/service-state.ts`'s `readDaemonState`). This module is the
 * shared implementation.
 *
 * Reads are total: any failure (missing file, unreadable file, malformed
 * JSON, failed validation) returns null. Callers must NOT distinguish
 * "missing" from "malformed" — the sentinel either says something
 * valid or it says nothing.
 *
 * Writes use a plain `writeFileSync`. Callers that need atomicity or
 * specific file modes (e.g. `daemon/service-state.ts`'s 0o600 on
 * daemon.json because it carries the bearer token) must roll their own
 * writer — see `service-state.ts:writeDaemonState`. The shared writer
 * here is for non-secret status sentinels only.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Read and validate a JSON sentinel. Returns the validated value on
 * success, or null when the file is missing, unreadable, or fails
 * validation.
 *
 * `validate` is the type guard the caller relies on. It receives the
 * raw parsed JSON (`unknown`) and narrows it to `T` only when every
 * required field is present and well-shaped.
 */
export function readJsonSentinel<T>(
  filePath: string,
  validate: (parsed: unknown) => parsed is T,
): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write a JSON sentinel. Creates the parent directory if needed and
 * serializes with `JSON.stringify(value, null, 2)` plus a trailing
 * newline so the on-disk shape is diff-friendly.
 *
 * Not atomic and does not set file mode — see module docstring.
 */
export function writeJsonSentinel(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Idempotently remove a sentinel. Returns silently when the file is
 * already absent; swallows any other unlink error too — callers use
 * sentinels for signaling, not as a transactional log.
 */
export function clearJsonSentinel(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}
