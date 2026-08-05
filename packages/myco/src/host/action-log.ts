/**
 * Team Host control-plane action log (Task 2.4) — the v1 "safety net" the spec's
 * flat-trust model calls for (§9: "Minimal host-side control-plane action log
 * (joins/evictions/rotations) keeps the v1 safety net diagnosable").
 *
 * A single append-only JSONL file under the machine-global host-control home
 * (`~/.myco-team/host/action-log.jsonl`). Deliberately NOT a Grove table: control-
 * plane events are host-machine facts, not tenancy data, so they stay out of the
 * Grove DB / team-sync path entirely (spec §8 keeps host administration on the
 * host localhost). Operator-readable by design.
 *
 * ONE writer for BOTH surfaces that produce control-plane events: the daemon's
 * team routes (core, `daemon/server.ts`) log `enroll` when a member joins and
 * `resign` when one surrenders its own access; the operator CLI (`myco-team
 * host`, which depends on core) logs `key-mint`/`evict`/`rotate`. Membership
 * both begins and ends on the daemon side, so both ends are recorded there —
 * an operator reading the roster needs to see that a member LEFT, not just
 * that a row went quiet. The
 * shared home path (`resolveHostControlDir`, core `grove/paths.ts`) is why this
 * module lives in core rather than `myco-team` — core cannot import `myco-team`.
 *
 * NEVER records a secret: a `key-mint` logs the user + expiration, never the key;
 * a `rotate` logs that a rotation happened, never the bearer value.
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveHostControlDir } from '../grove/paths.js';

/** The control-plane events worth a durable, operator-readable trail (spec §9). */
export type HostActionKind = 'enroll' | 'resign' | 'key-mint' | 'evict' | 'rotate';

export interface HostActionEvent {
  action: HostActionKind;
  /** The device/member the action concerns — overlay IP, node id, or headscale user. */
  subject?: string;
  /** Extra non-secret context (expiration, member hostname, …). Never a credential. */
  detail?: Record<string, unknown>;
}

export interface HostActionRecord extends HostActionEvent {
  /** ISO-8601 UTC timestamp, stamped at append time. */
  ts: string;
}

/** The JSONL file name under the host-control home. */
const ACTION_LOG_FILENAME = 'action-log.jsonl';

/**
 * Rotate once the live file exceeds this size. A control-plane log of
 * enroll/key-mint/evict/rotate events is low-volume (not a hot path like
 * transcript capture), so a generous 1 MB default cap is thousands of events
 * before the first rotation — but the file is append-only forever without
 * one, so a long-lived host would otherwise grow it unbounded.
 */
const DEFAULT_ACTION_LOG_MAX_BYTES = 1_048_576;

/** Numbered backups kept beyond the live file (`action-log.jsonl.1` newest .. `.N` oldest). */
const DEFAULT_ACTION_LOG_MAX_BACKUPS = 3;

export interface HostActionLogRotationOptions {
  /** Override {@link DEFAULT_ACTION_LOG_MAX_BYTES} (tests exercise rotation without writing a real 1 MB). */
  maxBytes?: number;
  /** Override {@link DEFAULT_ACTION_LOG_MAX_BACKUPS}. */
  maxBackups?: number;
}

/** Resolve the action-log path under the (default machine-global) host-control home. */
export function hostActionLogPath(controlDir: string = resolveHostControlDir()): string {
  return path.join(controlDir, ACTION_LOG_FILENAME);
}

function hostActionLogBackupPath(controlDir: string, n: number): string {
  return `${hostActionLogPath(controlDir)}.${n}`;
}

/**
 * Rotate the live file to `.1`, shifting existing backups up to `maxBackups`
 * and dropping the oldest. Mirrors `DaemonLogger`'s numbered-backup rotation
 * (`daemon/logger.ts`), scaled down for a function-based, non-hot-path writer
 * that has no persistent fd to manage. Missing live file (nothing written
 * yet) is a no-op.
 */
function rotateActionLogIfNeeded(controlDir: string, options: HostActionLogRotationOptions): void {
  const maxBytes = options.maxBytes ?? DEFAULT_ACTION_LOG_MAX_BYTES;
  const maxBackups = options.maxBackups ?? DEFAULT_ACTION_LOG_MAX_BACKUPS;
  const logPath = hostActionLogPath(controlDir);
  let size: number;
  try { size = fs.statSync(logPath).size; }
  catch { return; }
  if (size <= maxBytes) return;

  for (let i = maxBackups - 1; i >= 1; i -= 1) {
    const from = hostActionLogBackupPath(controlDir, i);
    if (!fs.existsSync(from)) continue;
    const to = hostActionLogBackupPath(controlDir, i + 1);
    fs.renameSync(from, to);
  }
  fs.renameSync(logPath, hostActionLogBackupPath(controlDir, 1));
}

/**
 * Append one control-plane event as a JSONL line (timestamp stamped here). The
 * directory is created on demand so the first enrollment on a fresh host writes
 * cleanly. Best-effort by contract for the enrollment hot path: a failed append
 * must never break enrollment (the log is a diagnostic aid, not the trust
 * boundary), so callers on that path swallow errors.
 */
export function appendHostAction(
  event: HostActionEvent,
  controlDir: string = resolveHostControlDir(),
  rotation: HostActionLogRotationOptions = {},
): void {
  const record: HostActionRecord = { ts: new Date().toISOString(), ...event };
  fs.mkdirSync(controlDir, { recursive: true });
  rotateActionLogIfNeeded(controlDir, rotation);
  fs.appendFileSync(hostActionLogPath(controlDir), `${JSON.stringify(record)}\n`, 'utf-8');
}

/**
 * Read the action log oldest-first, spanning rotated backups
 * (`action-log.jsonl.N` oldest .. `.1`, then the live file) so a host that has
 * rotated at least once does not silently lose history from the operator's
 * view. Missing files → empty; unparseable lines skipped.
 */
export function readHostActionLog(
  controlDir: string = resolveHostControlDir(),
  rotation: HostActionLogRotationOptions = {},
): HostActionRecord[] {
  const maxBackups = rotation.maxBackups ?? DEFAULT_ACTION_LOG_MAX_BACKUPS;
  const records: HostActionRecord[] = [];
  const parseFile = (filePath: string): void => {
    let raw: string;
    try { raw = fs.readFileSync(filePath, 'utf-8'); }
    catch { return; }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { records.push(JSON.parse(trimmed) as HostActionRecord); }
      catch { /* skip a torn/partial line */ }
    }
  };

  for (let i = maxBackups; i >= 1; i -= 1) {
    parseFile(hostActionLogBackupPath(controlDir, i));
  }
  parseFile(hostActionLogPath(controlDir));
  return records;
}
