/**
 * Process identity for lease holders (write-admission W4).
 *
 * A project write lease records WHICH process took it, so "is this lease
 * still held?" can be answered from facts rather than from the age of the
 * record. Without it the only available signal is `since`, which is why the
 * pre-W4 design needed a staleness sweeper — and why a lease whose project
 * had been deregistered could never be swept at all.
 *
 * Identity is `(pid, boot_id)`, not a bare pid. A bare pid is reusable: after
 * a reboot some unrelated process almost certainly holds the number, and a
 * dead holder would read as alive forever. `boot_id` is the machine's boot
 * instant, so a lease taken before a reboot is recognisably stale no matter
 * what now owns its pid.
 *
 * Two residuals, both stated rather than hidden — and they fail in OPPOSITE
 * directions, which is why neither is glossed:
 *
 *  1. **pid reuse within a single boot** is not detected. Safe direction: an
 *     unrelated process inheriting the pid makes the lease read HELD, which
 *     stalls writes until that process exits. Closing it needs a process
 *     start-time read, which has no portable API — not worth it for a
 *     bounded stall.
 *
 *  2. **a wall-clock step, where the boot id has to be derived from the
 *     clock** (see `currentBootId`). DANGEROUS direction: it shifts the
 *     computed boot id within one boot, so every live holder reads DEAD and
 *     its lease can be freed while the operation is still running. An NTP
 *     `makestep`, a manual `date -s`, or a hypervisor time-sync after a VM
 *     pause all clear any plausible tolerance. This is why Linux reads a real
 *     boot identity instead of computing one, and why the fallback's exposure
 *     is named here rather than asserted away.
 */

import fs from 'node:fs';
import os from 'node:os';

export interface LeaseHolder {
  /** The process that took the lease. */
  pid: number;
  /**
   * Identifies the BOOT the holder belongs to, so pid reuse across reboots
   * cannot make a dead holder read alive.
   *
   * Two shapes, because only one platform offers a real one:
   *   - Linux: the kernel's `boot_id` UUID, compared exactly. Immune to
   *     clock changes.
   *   - elsewhere: the boot instant in epoch seconds as a decimal string,
   *     derived from the wall clock and therefore compared with a tolerance.
   *     See residual 2 in the module docs.
   */
  boot_id: string;
}

/**
 * An identifier for the current boot.
 *
 * Prefers the kernel's own `boot_id` UUID (Linux), which is authoritative and
 * immune to clock changes. Falls back to now-minus-uptime as a decimal
 * string, which is stable within a boot to `os.uptime()`'s resolution but
 * moves with the wall clock — hence the tolerance in `sameBoot`, and residual
 * 2 in the module docs.
 */
export function currentBootId(): string {
  // The kernel's own per-boot UUID: authoritative, and unaffected by any
  // clock change. Present on Linux, which is the platform a Team Host is
  // most likely to be — and most likely to be a VM with step-on-start NTP.
  try {
    const kernelBootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
    if (kernelBootId) return kernelBootId;
  } catch {
    // Not Linux, or the file is unreadable — fall through to the derivation.
  }
  return String(Math.floor(Date.now() / 1000 - os.uptime()));
}

/**
 * Boot instants are computed from a live uptime reading, so two readings of
 * the same boot can differ slightly. A few seconds of tolerance keeps that
 * jitter from reading as a reboot; real reboots move this by far more.
 */
const BOOT_ID_TOLERANCE_SECONDS = 5;

function sameBoot(recorded: string, current: string): boolean {
  // A real kernel boot id is exact — no tolerance, and a mismatch is a
  // genuine reboot.
  if (recorded === current) return true;
  const a = Number(recorded);
  const b = Number(current);
  // One side is a UUID and the other is not: different shapes cannot be the
  // same boot (a binary that used the derivation, then one that reads the
  // kernel, or vice versa). Treat as a reboot — the safe direction is
  // ambiguous here, but the alternative is comparing a UUID to a number.
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= BOOT_ID_TOLERANCE_SECONDS;
}

/** Identity of the calling process, stamped into a lease at acquisition. */
export function currentHolder(): LeaseHolder {
  return { pid: process.pid, boot_id: currentBootId() };
}

/**
 * Is the process that took this lease still running?
 *
 * `false` is a positive finding — the holder is provably gone — so callers
 * may free the lease on it, but only in combination with the operation's own
 * evidence (see `project-lease.ts`): a crashed operation that is still
 * resumable must keep its project blocked even though its process is dead.
 *
 * Signal 0 asks the kernel whether the pid exists without touching it. EPERM
 * means it exists under another user, which still counts as alive.
 */
export function isHolderAlive(holder: LeaseHolder): boolean {
  if (!sameBoot(holder.boot_id, currentBootId())) return false;
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
