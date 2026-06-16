/**
 * Subsystem ownership claims — a small, general "this daemon owns <subsystem>
 * on this machine" marker written into the shared `~/.myco/claims/` area.
 *
 * Two daemons can run on one machine (the production `service` daemon and a
 * contributor's dogfood `service-dev` daemon). For machine-global work that
 * both would otherwise perform — today: rewriting global agent/symbiont
 * configs — they'd fight, each clobbering the other's binary path on its next
 * tick. A claim lets one daemon assert ownership so the peer defers.
 *
 * The claim is just a file: present + the owner's pid still alive = held;
 * absent or owner-dead = free. There is no heartbeat — liveness is the owner
 * pid, so a crashed owner's claim is stale and the peer reclaims automatically
 * (no permanent lockout). Releasing is explicit (graceful shutdown) or implicit
 * (the owner dies). Inert for normal single-daemon installs: no peer ever
 * claims, so nothing is ever deferred.
 *
 * General by design — any future machine-global subsystem two daemons might
 * contend over can take a claim with a new subsystem name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { resolveMycoHome } from '../grove/paths.js';
import { isProcessAlive } from '../cli/shared.js';
import type { DaemonVariant } from '../grove/registry.js';

/** The symbiont-config (hooks/MCP) management subsystem — the first claim user. */
export const SYMBIONT_CONFIG_SUBSYSTEM = 'symbiont-config';

interface SubsystemClaim {
  subsystem: string;
  owner: DaemonVariant;
  pid: number;
  claimed_at: number;
}

/** Injectable seams so the claim store is unit-testable without a real daemon. */
export interface ClaimDeps {
  mycoHome?: string;
  /** Owner pid to record (default: this process). */
  pid?: number;
  /** Liveness probe for a recorded pid (default: the real OS check). */
  isAlive?: (pid: number) => boolean;
  /** Clock (default: Date.now). */
  now?: () => number;
}

function claimsDir(mycoHome: string): string {
  return path.join(mycoHome, 'claims');
}

function claimPath(subsystem: string, mycoHome: string): string {
  return path.join(claimsDir(mycoHome), `${subsystem}.json`);
}

function readClaim(subsystem: string, mycoHome: string): SubsystemClaim | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(claimPath(subsystem, mycoHome), 'utf-8')) as Partial<SubsystemClaim>;
    if (typeof parsed.owner === 'string' && typeof parsed.pid === 'number' && typeof parsed.subsystem === 'string') {
      return parsed as SubsystemClaim;
    }
    return null;
  } catch {
    return null;
  }
}

/** Assert ownership of `subsystem` for `owner`. Idempotent (overwrites). Best-effort. */
export function claimSubsystem(subsystem: string, owner: DaemonVariant, deps: ClaimDeps = {}): void {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const claim: SubsystemClaim = {
    subsystem,
    owner,
    pid: deps.pid ?? process.pid,
    claimed_at: (deps.now ?? Date.now)(),
  };
  try {
    fs.mkdirSync(claimsDir(mycoHome), { recursive: true });
    atomicWriteFileSync(claimPath(subsystem, mycoHome), JSON.stringify(claim, null, 2) + '\n');
  } catch { /* best-effort — a missing claim just means the peer doesn't defer */ }
}

/** Release a claim we hold. Only the recorded owner variant may release it. */
export function releaseSubsystemClaim(subsystem: string, owner: DaemonVariant, deps: ClaimDeps = {}): void {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const claim = readClaim(subsystem, mycoHome);
  if (claim && claim.owner === owner) {
    try { fs.unlinkSync(claimPath(subsystem, mycoHome)); } catch { /* already gone */ }
  }
}

/**
 * True when a DIFFERENT daemon variant holds a LIVE claim on `subsystem`. The
 * caller (`self`) should defer the subsystem's work. A claim by `self`, a stale
 * claim (owner pid dead), or no claim at all all return false.
 */
export function isClaimedByPeer(subsystem: string, self: DaemonVariant, deps: ClaimDeps = {}): boolean {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const claim = readClaim(subsystem, mycoHome);
  if (!claim || claim.owner === self) return false;
  return (deps.isAlive ?? isProcessAlive)(claim.pid);
}
