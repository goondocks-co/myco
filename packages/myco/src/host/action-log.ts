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
 * enrollment endpoint (core, `daemon/server.ts`) logs `enroll`; the operator CLI
 * (`myco-team host`, which depends on core) logs `key-mint`/`evict`/`rotate`. The
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
export type HostActionKind = 'enroll' | 'key-mint' | 'evict' | 'rotate';

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

/** Resolve the action-log path under the (default machine-global) host-control home. */
export function hostActionLogPath(controlDir: string = resolveHostControlDir()): string {
  return path.join(controlDir, ACTION_LOG_FILENAME);
}

/**
 * Append one control-plane event as a JSONL line (timestamp stamped here). The
 * directory is created on demand so the first enrollment on a fresh host writes
 * cleanly. Best-effort by contract for the enrollment hot path: a failed append
 * must never break enrollment (the log is a diagnostic aid, not the trust
 * boundary), so callers on that path swallow errors.
 */
export function appendHostAction(event: HostActionEvent, controlDir: string = resolveHostControlDir()): void {
  const record: HostActionRecord = { ts: new Date().toISOString(), ...event };
  fs.mkdirSync(controlDir, { recursive: true });
  fs.appendFileSync(hostActionLogPath(controlDir), `${JSON.stringify(record)}\n`, 'utf-8');
}

/** Read the action log oldest-first. Missing file → empty; unparseable lines skipped. */
export function readHostActionLog(controlDir: string = resolveHostControlDir()): HostActionRecord[] {
  let raw: string;
  try { raw = fs.readFileSync(hostActionLogPath(controlDir), 'utf-8'); }
  catch { return []; }
  const records: HostActionRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { records.push(JSON.parse(trimmed) as HostActionRecord); }
    catch { /* skip a torn/partial line */ }
  }
  return records;
}
