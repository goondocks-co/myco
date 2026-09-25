/**
 * Member token rotation — registry-sourced credentials only. An env-sourced
 * credential is the orchestrator's and never rotates: a successor's first use
 * revokes its predecessor, so refreshing an injected token would revoke it
 * under every other sandbox holding it.
 *
 * The credential is the Deployment membership's, held once for every project
 * bound to that Deployment, and it rotates as one: every binding reads the
 * successor from the moment it is written.
 *
 * The window is the server's: the announced `refreshAfter`, and until the
 * server has announced one, the last quarter of the TTL before `expiresAt`.
 * The registry lock is taken BEFORE dialing and the window re-checked inside
 * it, the successor is written atomically, the lock released — so two hooks
 * racing produce one successor and the loser keeps using the predecessor,
 * which stays valid until the successor is first used.
 *
 * A refusal that announces no `refreshAfter` is terminal: the entry records
 * it and nothing dials again until a new credential replaces the token
 * (`myco login`, `myco member join`), which clears it.
 *
 * A token past its own expiry still rotates: the server admits a lapsed token
 * on this route alone, up to its lineage ceiling, so a machine offline longer
 * than the TTL renews on its first hook back.
 */
import { resolveMycoHome } from '../paths/home.js';
import { getPluginVersion } from '../version.js';
import type { RequestBudget } from './budget.js';
import fs from 'node:fs';
import {
  MEMBER_TOKEN_REFRESH_WINDOW_MS, REFRESH_NO_PROJECT_BACKOFF_MS, ROUTE_MISSING_NOTICE_INTERVAL_MS, TERMINAL_RETRY_INTERVAL_MS, type MemberCode,
} from './constants.js';
import { REJOIN_HINT } from './delivery-notice.js';
import type { CredentialRecord } from './credential.js';
import {
  acquireRegistryLock, readDeploymentMembership, readRegistryEntry, writeDeploymentMembership, TOKEN_SCOPED_FIELDS, type DeploymentMembership, type RegistryEntry,
} from './registry.js';
import { refreshCredential, type ClientRecord, type FetchLike } from './transport.js';

export type RefreshStatus =
  | 'refreshed' | 'not-due' | 'busy' | 'no-entry'
  | 'too-early' | 'lineage-expired' | 'terminal' | 'unauthorized' | 'route-missing' | 'retry' | 'protocol';

export interface RefreshReport {
  status: RefreshStatus;
  entry: RegistryEntry | null;
  /** The successor's token id, when one was written. */
  tokenId?: string;
}

export interface RefreshOptions {
  mycoHome?: string;
  fetch?: FetchLike;
  now?: () => number;
  budget: RequestBudget;
  /** Dial whether or not the window is open — to learn whether a token a capture route refused still rotates. Never past a terminal refusal. */
  force?: boolean;
  /** The Project the request names, when the caller works in one; a membership no project is bound to names none. */
  projectId?: string;
}

/** Refusals that say the request, not the credential, fell short: the token may still rotate, so they are retried rather than recorded as final. `no_project` is a server that requires a Project on this route. */
const RETRYABLE_REFUSALS: readonly MemberCode[] = ['no_project'];

/** What `refreshDue` reads: the window the server announced, the expiry, whether rotation is already terminal and which build said so, and when each build last asked about it again. */
export type RefreshWindow = Pick<RegistryEntry, 'expiresAt' | 'refreshAfter' | 'refreshTerminal' | 'refreshTerminalBy' | 'refreshRetries'>;

/**
 * The identity of the running build: its version, and the program file it runs
 * from. Two builds of one version — development builds of one commit, a
 * reinstall — are told apart by the file.
 */
export function buildIdentity(): string {
  try {
    const stat = fs.statSync(process.execPath);
    return `${getPluginVersion()}@${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return getPluginVersion();
  }
}

/**
 * Whether a terminal refusal may be asked about again by `build`: never when
 * this build recorded it; otherwise once per `TERMINAL_RETRY_INTERVAL_MS`,
 * counted from the attempt this build last made, whatever that attempt was
 * answered with.
 */
const terminalRetryDue = (entry: RefreshWindow, now: number, build: string): boolean => {
  if (entry.refreshTerminalBy === build) return false;
  const last = entry.refreshRetries?.[build];
  return last === undefined || now - last >= TERMINAL_RETRY_INTERVAL_MS;
};

const stderr = (line: string): void => { process.stderr.write(`[myco] member: ${line}\n`); };

/**
 * True when the token's refresh window is open: after a terminal refusal, only
 * as `terminalRetryDue` allows; the announced `refreshAfter` when there is one;
 * otherwise the last quarter of the TTL before `expiresAt`. An entry that
 * knows neither is due — one dial teaches it the window the server keeps.
 */
export function refreshDue(entry: RefreshWindow, now: number, build: string = buildIdentity()): boolean {
  if (entry.refreshTerminal) return terminalRetryDue(entry, now, build);
  if (entry.refreshAfter !== undefined) return now >= entry.refreshAfter;
  if (entry.expiresAt !== undefined) return entry.expiresAt - now <= MEMBER_TOKEN_REFRESH_WINDOW_MS;
  return true;
}

/** The project root a credential may rotate: the registry entry's root, and nothing for an env-sourced credential. */
export function refreshableRoot(credential: Pick<CredentialRecord, 'source' | 'root'>): string | null {
  return credential.source === 'registry' ? credential.root ?? null : null;
}

/** What a rotation of a Deployment membership did, and the membership as it stands after it. */
export interface MembershipRefreshReport {
  status: RefreshStatus;
  membership: DeploymentMembership | null;
  /** The successor's token id, when one was written. */
  tokenId?: string;
}

/**
 * Rotate the credential this machine holds for the Deployment at `serverUrl`
 * when its window is open, or — with `force` — to learn whether a token a route
 * refused still rotates. The credential is the Deployment's and the request
 * names no Project, so a machine with no project bound to the Deployment (one
 * running only a worker) renews the same way a hook does. The registry lock is
 * held across the dial.
 */
export async function refreshMembership(serverUrl: string, opts: RefreshOptions): Promise<MembershipRefreshReport> {
  const mycoHome = opts.mycoHome ?? resolveMycoHome();
  const now = opts.now ?? Date.now;
  const build = buildIdentity();
  const due = (held: RefreshWindow): boolean => (opts.force === true && held.refreshTerminal !== true) || refreshDue(held, now(), build);
  const before = readDeploymentMembership(serverUrl, mycoHome);
  if (!before) return { status: 'no-entry', membership: null };
  if (!due(before)) return { status: 'not-due', membership: before };

  const lock = acquireRegistryLock(mycoHome);
  if (!lock.acquired) return { status: 'busy', membership: before };
  try {
    // Re-read inside the lock: the winner of a race has already written the successor this membership would have asked for.
    let held = readDeploymentMembership(serverUrl, mycoHome);
    if (!held) return { status: 'no-entry', membership: null };
    if (held.token !== before.token || !due(held)) return { status: 'not-due', membership: held };

    // Asking again about another build's terminal refusal is recorded before the dial, so whatever answers it, this build asks once per interval.
    if (held.refreshTerminal === true) {
      const retries = Object.fromEntries(Object.entries(held.refreshRetries ?? {}).filter(([, at]) => now() - at < TERMINAL_RETRY_INTERVAL_MS));
      held = { ...held, refreshRetries: { ...retries, [build]: now() }, updatedAt: now() };
      writeDeploymentMembership(held, { mycoHome, locked: true });
    }
    const outcome = await refreshCredential({ serverUrl: held.serverUrl, token: held.token, projectId: opts.projectId }, opts.fetch ?? globalThis.fetch, opts.budget);
    const write = (next: Partial<DeploymentMembership>): DeploymentMembership | null => {
      writeDeploymentMembership({ ...held, ...next, updatedAt: now() }, { mycoHome, locked: true });
      return readDeploymentMembership(serverUrl, mycoHome);
    };
    /** The membership as the successor holds it: nothing of the predecessor's own state carried over. */
    const succeed = (next: Pick<DeploymentMembership, 'token' | 'tokenId' | 'expiresAt' | 'refreshAfter'>): DeploymentMembership | null => {
      const kept: Partial<DeploymentMembership> = { ...held };
      for (const field of TOKEN_SCOPED_FIELDS) delete kept[field];
      writeDeploymentMembership({ ...(kept as DeploymentMembership), ...next, updatedAt: now() }, { mycoHome, locked: true });
      return readDeploymentMembership(serverUrl, mycoHome);
    };
    switch (outcome.class) {
      case 'refreshed':
        return {
          status: 'refreshed',
          tokenId: outcome.tokenId,
          membership: succeed({ token: outcome.token, tokenId: outcome.tokenId, expiresAt: outcome.expiresAt, refreshAfter: outcome.refreshAfter }),
        };
      case 'refused': {
        if (RETRYABLE_REFUSALS.includes(outcome.code)) {
          // A membership no project is bound to can never name one, so it waits before it asks again.
          return { status: 'retry', membership: opts.projectId === undefined ? write({ refreshAfter: now() + REFRESH_NO_PROJECT_BACKOFF_MS }) : held };
        }
        if (outcome.refreshAfter !== undefined) {
          // A window announced is a token that still rotates: any terminal refusal recorded against it no longer holds.
          return { status: outcome.code === 'refresh_too_early' ? 'too-early' : 'terminal', membership: write({ refreshAfter: outcome.refreshAfter, refreshTerminal: false }) };
        }
        if (outcome.code === 'lineage_expired') {
          stderr(`token lineage expired — capture stops reaching the server at ${new Date(held.expiresAt ?? now()).toISOString()}; ${REJOIN_HINT}`);
          return { status: 'lineage-expired', membership: write({ refreshTerminal: true, refreshTerminalBy: build }) };
        }
        stderr(`token rotation refused (${outcome.code})${outcome.reason ? `: ${outcome.reason}` : ''} — ${REJOIN_HINT}`);
        return { status: 'terminal', membership: write({ refreshTerminal: true, refreshTerminalBy: build }) };
      }
      case 'unauthorized':
        stderr(`member token refused — ${REJOIN_HINT}`);
        // The token no longer authenticates anywhere, so its life ended now, whatever expiry it was issued with.
        return { status: 'unauthorized', membership: write({ refreshTerminal: true, refreshTerminalBy: build, expiresAt: Math.min(held.expiresAt ?? now(), now()) }) };
      case 'route_missing': {
        const noticedAt = held.routeMissingNoticedAt ?? 0;
        if (now() - noticedAt < ROUTE_MISSING_NOTICE_INTERVAL_MS) return { status: 'route-missing', membership: held };
        stderr('this server does not rotate member tokens — the token will expire unrefreshed; upgrade the server');
        return { status: 'route-missing', membership: write({ routeMissingNoticedAt: now() }) };
      }
      case 'protocol':
        return { status: 'protocol', membership: held };
      default:
        return { status: 'retry', membership: held };
    }
  } finally {
    lock.lock.release();
  }
}

/** Rotate the credential the registry entry for `root` holds, as `refreshMembership` does, and report the entry as it stands after. */
export async function refreshMemberCredential(root: string, opts: RefreshOptions): Promise<RefreshReport> {
  const mycoHome = opts.mycoHome ?? resolveMycoHome();
  const entry = readRegistryEntry(root, mycoHome);
  if (!entry) return { status: 'no-entry', entry: null };
  const report = await refreshMembership(entry.serverUrl, { ...opts, mycoHome, projectId: entry.projectId });
  return { status: report.status, tokenId: report.tokenId, entry: report.membership === null ? null : readRegistryEntry(root, mycoHome) };
}

/**
 * The live-send 401 answer: another hook may have rotated this root's token
 * since `presented` was resolved, so the registry is re-read and its record
 * returned when it names a different token. Null when nothing changed — the
 * events stay spooled and the operator re-provisions.
 */
export function rotatedCredential(root: string, presented: ClientRecord, mycoHome: string = resolveMycoHome()): ClientRecord | null {
  const entry = readRegistryEntry(root, mycoHome);
  if (!entry || entry.token === presented.token) return null;
  return { serverUrl: entry.serverUrl, token: entry.token, projectId: entry.projectId };
}
