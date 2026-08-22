/**
 * Member token rotation — registry-sourced credentials only. An env-sourced
 * credential is the orchestrator's and never rotates: a successor's first use
 * revokes its predecessor, so refreshing an injected token would revoke it
 * under every other sandbox holding it.
 *
 * The window is the server's: the announced `refreshAfter`, and until the
 * server has announced one, the last quarter of the TTL before `expiresAt`.
 * The registry lock is taken BEFORE dialing and the window re-checked inside
 * it, the successor is written atomically, the lock released — so two hooks
 * racing produce one successor and the loser keeps using the predecessor,
 * which stays valid until the successor is first used.
 *
 * A refusal that announces no `refreshAfter` is terminal: the entry records
 * it and nothing dials again until `myco member join` re-provisions.
 */
import { resolveMycoHome } from '../paths/home.js';
import type { RequestBudget } from './budget.js';
import { MEMBER_TOKEN_REFRESH_WINDOW_MS, ROUTE_MISSING_NOTICE_INTERVAL_MS } from './constants.js';
import type { CredentialRecord } from './credential.js';
import { acquireRegistryLock, readRegistryEntry, writeRegistryEntry, type RegistryEntry } from './registry.js';
import { ServerClient, type ClientRecord, type FetchLike } from './transport.js';

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
}

/** What `refreshDue` reads: the window the server announced, the expiry, and whether rotation is already terminal. */
export type RefreshWindow = Pick<RegistryEntry, 'expiresAt' | 'refreshAfter' | 'refreshTerminal'>;

const stderr = (line: string): void => { process.stderr.write(`[myco] member: ${line}\n`); };

/**
 * True when the token's refresh window is open: never after a terminal
 * refusal; the announced `refreshAfter` when there is one; otherwise the last
 * quarter of the TTL before `expiresAt`. An entry that knows neither is due —
 * one dial teaches it the window the server keeps.
 */
export function refreshDue(entry: RefreshWindow, now: number): boolean {
  if (entry.refreshTerminal) return false;
  if (entry.refreshAfter !== undefined) return now >= entry.refreshAfter;
  if (entry.expiresAt !== undefined) return entry.expiresAt - now <= MEMBER_TOKEN_REFRESH_WINDOW_MS;
  return true;
}

/** The project root a credential may rotate: the registry entry's root, and nothing for an env-sourced credential. */
export function refreshableRoot(credential: Pick<CredentialRecord, 'source' | 'root'>): string | null {
  return credential.source === 'registry' ? credential.root ?? null : null;
}

/** Rotate the registry entry for `root` when its window is open; the registry lock is held across the dial. */
export async function refreshMemberCredential(root: string, opts: RefreshOptions): Promise<RefreshReport> {
  const mycoHome = opts.mycoHome ?? resolveMycoHome();
  const now = opts.now ?? Date.now;
  const before = readRegistryEntry(root, mycoHome);
  if (!before) return { status: 'no-entry', entry: null };
  if (!refreshDue(before, now())) return { status: 'not-due', entry: before };

  const lock = acquireRegistryLock(mycoHome);
  if (!lock.acquired) return { status: 'busy', entry: before };
  try {
    // Re-read inside the lock: the winner of a race has already written the successor this entry would have asked for.
    const entry = readRegistryEntry(root, mycoHome);
    if (!entry) return { status: 'no-entry', entry: null };
    if (!refreshDue(entry, now())) return { status: 'not-due', entry };

    const client = new ServerClient(entry, opts.fetch ?? globalThis.fetch);
    const outcome = await client.refresh(opts.budget);
    const write = (next: Partial<RegistryEntry>): RegistryEntry => {
      const updated: RegistryEntry = { ...entry, ...next, updatedAt: now() };
      writeRegistryEntry(updated, { mycoHome, locked: true });
      return updated;
    };
    switch (outcome.class) {
      case 'refreshed':
        return {
          status: 'refreshed',
          tokenId: outcome.tokenId,
          entry: write({ token: outcome.token, tokenId: outcome.tokenId, expiresAt: outcome.expiresAt, refreshAfter: outcome.refreshAfter }),
        };
      case 'refused': {
        if (outcome.refreshAfter !== undefined) {
          return { status: outcome.code === 'refresh_too_early' ? 'too-early' : 'terminal', entry: write({ refreshAfter: outcome.refreshAfter }) };
        }
        if (outcome.code === 'lineage_expired') {
          stderr(`token lineage expired — re-provision with \`myco member join\` before ${new Date(entry.expiresAt ?? now()).toISOString()}`);
          return { status: 'lineage-expired', entry: write({ refreshTerminal: true }) };
        }
        stderr(`token rotation refused (${outcome.code})${outcome.reason ? `: ${outcome.reason}` : ''} — re-provision with \`myco member join\``);
        return { status: 'terminal', entry: write({ refreshTerminal: true }) };
      }
      case 'unauthorized':
        stderr('member token refused — re-provision with `myco member join`');
        return { status: 'unauthorized', entry: write({ refreshTerminal: true }) };
      case 'route_missing': {
        const noticedAt = entry.routeMissingNoticedAt ?? 0;
        if (now() - noticedAt < ROUTE_MISSING_NOTICE_INTERVAL_MS) return { status: 'route-missing', entry };
        stderr('this server does not rotate member tokens — the token will expire unrefreshed; upgrade the server');
        return { status: 'route-missing', entry: write({ routeMissingNoticedAt: now() }) };
      }
      case 'protocol':
        return { status: 'protocol', entry };
      default:
        return { status: 'retry', entry };
    }
  } finally {
    lock.lock.release();
  }
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
