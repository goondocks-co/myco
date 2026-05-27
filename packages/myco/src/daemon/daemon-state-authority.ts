/**
 * Daemon state authority — the only module that mutates `daemon.json`.
 *
 * ## The invariant this enforces
 *
 * `daemon.json` MUST be present whenever a live daemon owns the canonical
 * port. The hook discovery fallback can mask transient absence (lock-tier,
 * `/health`-tier), and the self-reconciler can re-assert eventually, but
 * any observable gap costs capture latency and erodes the tenet that
 * `pid alive ⇔ daemon.json exists`.
 *
 * The prior arrangement made the invariant a code-review contract:
 *
 *   - `removeDaemonState` was documented as the sole production deletion
 *     path, called only from `reconcileExistingDaemon`.
 *   - `cli/doctor.ts:fix` and `cli/remove.ts` bypassed it with raw
 *     `fs.unlinkSync` calls against the same path.
 *   - Any future caller who imported `fs` and resolved the path could
 *     break the tenet without tripping a structural gate.
 *
 * This module makes the invariant structural in three complementary ways:
 *
 *   1. It is the ONLY module that calls `fs.unlinkSync` (or its
 *      variants) on the daemon-state path. The CI test gate at
 *      `tests/daemon/state-authority-gate.test.ts` fails the build if
 *      any other production module grows such a call.
 *   2. `DaemonServiceState.statePath` is branded as `DaemonStatePath`
 *      and constructed inside `resolveDaemonServiceState()` via a cast
 *      — discipline, not airtight prevention. Any direct mutation
 *      bypassing the authority must cast to `string`, which is
 *      grep-able and caught by the gate above.
 *   3. Succession is an atomic in-place overwrite via `write()`, not a
 *      delete-then-write. The file is never observably absent during a
 *      takeover.
 *
 * Every mutation requires a `reason: string` and logs a structured event
 * (`LOG_KINDS.DAEMON_STATE_MUTATION`) with caller pid, before/after pid,
 * and a short stack snapshot. The next regression is diagnosable from
 * `daemon.log` alone — no temporary instrumentation needed.
 *
 * Related: superseded portions of the "daemon.json Lifecycle Discipline"
 * wisdom spore — that document treated the rule as a tenet enforced by
 * convention; this module enforces it as a capability.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  type DaemonState,
  type DaemonServiceState,
  type DaemonStatePath,
  readDaemonState as readDaemonStateRaw,
} from './service-state.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { LOG_KINDS } from '../constants/log-kinds.js';

/**
 * Minimal structural logger interface accepted by the authority. The
 * production `DaemonLogger` satisfies it; CLI callers (`doctor`) can
 * pass a console-bound shim without depending on the daemon logger
 * machinery.
 */
export interface StateMutationLogger {
  info: (event: string, message: string, meta?: Record<string, unknown>) => void;
}

export type { DaemonStatePath };

export type StateMutationOp =
  | 'write'
  | 'write-or-touch'
  | 'delete-if-owned-by'
  | 'delete-if-malformed';

/**
 * Structured payload attached to every `DAEMON_STATE_MUTATION` log
 * event. Field key `op` (not `kind`) deliberately avoids colliding with
 * the logger's own `kind` field — the JSON log line carries both:
 *   `"kind":"daemon.state-mutation","op":"delete-if-owned-by"`
 * which lets log readers filter on the LOG_KIND class first, then the
 * specific mutation op within it.
 */
interface MutationLogFields {
  [key: string]: unknown;
  op: StateMutationOp;
  reason: string;
  caller_pid: number;
  before_pid: number | null;
  after_pid: number | null;
  outcome:
    | 'wrote'
    | 'touched'
    | 'deleted'
    | 'noop-pid-mismatch'
    | 'noop-now-parseable'
    | 'noop-absent';
  stack?: string;
}

/**
 * Construct the authority. Done once at daemon boot from
 * `resolveDaemonServiceState`. The returned handle is the only thing
 * downstream consumers should accept for daemon-state writes.
 */
export function createDaemonStateAuthority(
  service: DaemonServiceState,
  logger: StateMutationLogger,
): DaemonStateAuthority {
  return new DaemonStateAuthority(service.statePath, logger);
}

export class DaemonStateAuthority {
  constructor(
    private readonly statePath: DaemonStatePath,
    private readonly logger: StateMutationLogger,
  ) {}

  /** Path accessor for read-only consumers (logging, doctor diagnostics).
   *  Returns the branded type, not a raw string. */
  get path(): DaemonStatePath {
    return this.statePath;
  }

  read(): DaemonState | null {
    return readDaemonStateRaw(this.statePath);
  }

  write(state: DaemonState, opts: { reason: string }): void {
    const before = this.read();
    this.writeAtomic(state);
    this.logMutation({
      op: 'write',
      reason: opts.reason,
      caller_pid: process.pid,
      before_pid: before?.pid ?? null,
      after_pid: state.pid,
      outcome: 'wrote',
    });
  }

  writeOrTouch(state: DaemonState, opts: { reason: string }): void {
    const observed = this.read();
    if (observed && daemonStateEqual(observed, state)) {
      try {
        const now = new Date();
        fs.utimesSync(this.statePath, now, now);
        this.logMutation({
          op: 'write-or-touch',
          reason: opts.reason,
          caller_pid: process.pid,
          before_pid: observed.pid,
          after_pid: state.pid,
          outcome: 'touched',
        });
        return;
      } catch {
        // Fall through to full write — deleted under us, etc.
      }
    }
    this.writeAtomic(state);
    this.logMutation({
      op: 'write-or-touch',
      reason: opts.reason,
      caller_pid: process.pid,
      before_pid: observed?.pid ?? null,
      after_pid: state.pid,
      outcome: 'wrote',
    });
  }

  /**
   * Conditional deletion. Re-reads the file under the same authority and
   * no-ops if the recorded pid no longer matches `pid` (a successor wrote
   * fresh state into the gap).
   *
   * The only conditional deletion path. `cli/doctor.ts:fix` routes here
   * for the "stale PID" case so a doctor-driven cleanup never deletes a
   * refreshed daemon.json.
   */
  deleteIfOwnedBy(
    pid: number,
    opts: { reason: string },
  ): 'deleted' | 'noop' {
    const observed = this.read();
    if (observed === null) {
      this.logMutation({
        op: 'delete-if-owned-by',
        reason: opts.reason,
        caller_pid: process.pid,
        before_pid: null,
        after_pid: null,
        outcome: 'noop-absent',
        stack: shortStack(),
      });
      return 'noop';
    }
    if (observed.pid !== pid) {
      this.logMutation({
        op: 'delete-if-owned-by',
        reason: opts.reason,
        caller_pid: process.pid,
        before_pid: observed.pid,
        after_pid: observed.pid,
        outcome: 'noop-pid-mismatch',
        stack: shortStack(),
      });
      return 'noop';
    }
    try {
      fs.unlinkSync(this.statePath);
    } catch {
      // Already gone between the read and unlink — treat as noop.
      this.logMutation({
        op: 'delete-if-owned-by',
        reason: opts.reason,
        caller_pid: process.pid,
        before_pid: pid,
        after_pid: null,
        outcome: 'noop-absent',
        stack: shortStack(),
      });
      return 'noop';
    }
    this.logMutation({
      op: 'delete-if-owned-by',
      reason: opts.reason,
      caller_pid: process.pid,
      before_pid: pid,
      after_pid: null,
      outcome: 'deleted',
      stack: shortStack(),
    });
    return 'deleted';
  }

  /**
   * Bounded deletion for the unparseable-file case.
   *
   * Re-reads the file under the authority — if it's now parseable, a
   * successor refreshed it between the doctor's malformed-detection
   * pass and the fix attempt; no-op. If still unparseable, unlink.
   * Mirrors `deleteIfOwnedBy`'s re-read-and-confirm pattern for the
   * one case where pid-based ownership can't be determined.
   */
  deleteIfMalformed(opts: { reason: string }): 'deleted' | 'noop' {
    const observed = this.read();
    if (observed !== null) {
      this.logMutation({
        op: 'delete-if-malformed',
        reason: opts.reason,
        caller_pid: process.pid,
        before_pid: observed.pid,
        after_pid: observed.pid,
        outcome: 'noop-now-parseable',
        stack: shortStack(),
      });
      return 'noop';
    }
    try {
      fs.unlinkSync(this.statePath);
    } catch {
      this.logMutation({
        op: 'delete-if-malformed',
        reason: opts.reason,
        caller_pid: process.pid,
        before_pid: null,
        after_pid: null,
        outcome: 'noop-absent',
        stack: shortStack(),
      });
      return 'noop';
    }
    this.logMutation({
      op: 'delete-if-malformed',
      reason: opts.reason,
      caller_pid: process.pid,
      before_pid: null,
      after_pid: null,
      outcome: 'deleted',
      stack: shortStack(),
    });
    return 'deleted';
  }

  private writeAtomic(state: DaemonState): void {
    const dir = path.dirname(this.statePath);
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o700); } catch { /* non-POSIX; ignore */ }
    atomicWriteFileSync(this.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  private logMutation(fields: MutationLogFields): void {
    this.logger.info(LOG_KINDS.DAEMON_STATE_MUTATION, 'daemon.json mutation', fields);
  }
}

function daemonStateEqual(a: DaemonState, b: DaemonState): boolean {
  return a.pid === b.pid
    && a.port === b.port
    && (a.command ?? null) === (b.command ?? null)
    && (a.started ?? undefined) === (b.started ?? undefined)
    && (a.version ?? undefined) === (b.version ?? undefined)
    && (a.auth_token ?? undefined) === (b.auth_token ?? undefined)
    && stringArraysEqual(a.sessions, b.sessions);
}

function stringArraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function shortStack(): string {
  return new Error().stack?.split('\n').slice(2, 5).join('\n').trim() ?? '';
}
