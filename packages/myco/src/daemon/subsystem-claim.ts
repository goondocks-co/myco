/**
 * Subsystem ownership claims — a small, general "this daemon owns <subsystem>
 * on this machine" marker written into the shared `~/.myco/claims/` area.
 *
 * Two daemons can run on one machine — two independent installs in two homes
 * (`~/.myco` and a dogfood `~/.myco-dev`). For machine-global work that both
 * would otherwise perform — today: rewriting global agent/symbiont configs —
 * they'd fight, each clobbering the other's binary path on its next tick. A
 * claim lets the operator declare which daemon owns the subsystem so the peer
 * defers. The owner is an opaque token — the daemon's home path
 * (`daemonIdentity`) — compared by equality.
 *
 * Deliberately operator-driven, not automatic (mirrors `myco grove claim`): a
 * claim is taken with `myco subsystem claim <name>` and dropped with
 * `myco subsystem release <name>`. The claim is durable — it persists across
 * daemon restarts and until explicitly released, so the owner is a stated
 * intent rather than a function of which process happens to be alive. The peer
 * daemon never writes a claim; it only reads one and opts out of the work.
 *
 * The claim is just a file: present and owned by a different token = the peer
 * defers; absent = free. A stale claim (owner daemon long gone, never released)
 * is cleared the same way it was taken — `myco subsystem release` — and is
 * visible via `myco subsystem list`. Inert for normal single-daemon installs:
 * no operator ever claims, so nothing is ever deferred.
 *
 * General by design — any future machine-global subsystem two daemons might
 * contend over can take a claim with a new subsystem name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { resolveMycoHome } from '../grove/paths.js';

/** The symbiont-config (hooks/MCP) management subsystem — the first claim user. */
export const SYMBIONT_CONFIG_SUBSYSTEM = 'symbiont-config';

/**
 * Subsystems that may be claimed. The CLI validates against this so a typo
 * can't write a claim file no daemon ever reads (a silently-dead claim). Add a
 * name here when wiring a new subsystem's deferral guard.
 */
export const KNOWN_SUBSYSTEMS: readonly string[] = [SYMBIONT_CONFIG_SUBSYSTEM];

export interface SubsystemClaim {
  subsystem: string;
  /** Opaque owner token — the owning daemon's home path (`daemonIdentity`). */
  owner: string;
  /** The pid that took the claim — informational only (for `subsystem list`). */
  pid: number;
  claimed_at: number;
}

/** Injectable seams so the claim store is unit-testable without a real daemon. */
export interface ClaimDeps {
  mycoHome?: string;
  /** Owner pid to record (default: this process). */
  pid?: number;
  /** Clock (default: Date.now). */
  now?: () => number;
}

function claimsDir(mycoHome: string): string {
  return path.join(mycoHome, 'claims');
}

function claimPath(subsystem: string, mycoHome: string): string {
  return path.join(claimsDir(mycoHome), `${subsystem}.json`);
}

export function readClaim(subsystem: string, mycoHome = resolveMycoHome()): SubsystemClaim | null {
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

/** Every active claim on this machine, for `myco subsystem list`. */
export function listSubsystemClaims(deps: ClaimDeps = {}): SubsystemClaim[] {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  let entries: string[];
  try {
    entries = fs.readdirSync(claimsDir(mycoHome));
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.json'))
    .map((name) => readClaim(name.slice(0, -'.json'.length), mycoHome))
    .filter((claim): claim is SubsystemClaim => claim !== null);
}

/** Assert ownership of `subsystem` for `owner`. Idempotent (overwrites). Best-effort. */
export function claimSubsystem(subsystem: string, owner: string, deps: ClaimDeps = {}): void {
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

/** Release a claim. Only the recorded owner may release it. */
export function releaseSubsystemClaim(subsystem: string, owner: string, deps: ClaimDeps = {}): void {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const claim = readClaim(subsystem, mycoHome);
  if (claim && claim.owner === owner) {
    try { fs.unlinkSync(claimPath(subsystem, mycoHome)); } catch { /* already gone */ }
  }
}

/**
 * True when a DIFFERENT daemon holds a claim on `subsystem`. The caller
 * (`self`, an owner token) should defer the subsystem's work. A claim by
 * `self`, or no claim at all, returns false. Durable: the claim stands until
 * explicitly released, so this is a pure function of the on-disk marker — no
 * process-liveness check.
 */
export function isClaimedByPeer(subsystem: string, self: string, deps: ClaimDeps = {}): boolean {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const claim = readClaim(subsystem, mycoHome);
  return claim !== null && claim.owner !== self;
}
