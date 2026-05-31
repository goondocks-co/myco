/**
 * Machine identity generation — deterministic `{github_user}_{machine_hash}` format.
 *
 * The machine ID uniquely identifies a (user, machine) pair for backup dedup
 * and team sync. It is computed once, cached to `~/.myco/machine_id`,
 * and reused on subsequent calls — one identity per machine, shared across
 * every Grove and every project on that machine.
 *
 * Format: `{github_user}_{machine_hash}` where machine_hash is a truncated
 * SHA-256 of `os.hostname() + os.homedir()`.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveMachineIdPath, resolveMycoHome } from '../grove/paths.js';

/** Length of the truncated machine hash suffix. */
const MACHINE_HASH_LENGTH = 8;

/** Filename for the cached machine ID within a legacy project vault. */
const LEGACY_MACHINE_ID_FILE = 'machine_id';

/** Fallback GitHub username when `gh` CLI is unavailable. */
const FALLBACK_GITHUB_USER = 'local';

/**
 * Timeout for the best-effort `gh` username lookup during id generation.
 *
 * The username is only a cosmetic prefix on the machine id; the id's
 * stability comes from the persisted `~/.myco/machine_id` file and the
 * deterministic machine hash, NOT from `gh`. Generation only happens on a
 * cold module cache AND an absent id file, and it now sits on the
 * synchronous synced-write path (`syncRow` → `getTeamMachineId` →
 * `getMachineId`) for processes that never ran `initTeamContext`
 * (MCP server, agent subprocess). A long `gh` timeout there would stall
 * the first synced write. Bound it tightly so a slow/hung/unauthenticated
 * `gh` falls back to FALLBACK_GITHUB_USER fast instead of blocking the
 * write path. The persisted id is unaffected once written.
 */
const GH_USER_TIMEOUT_MS = 1500;

/** Module-level cache — set on first getMachineId() call, never cleared. */
let cachedMachineId: string | undefined;

/**
 * Reset the in-memory machine ID cache.
 *
 * Test-only — call in beforeEach to restore per-test filesystem isolation
 * when MYCO_HOME is redirected to a temp directory between tests.
 */
export function resetMachineIdCache(): void {
  cachedMachineId = undefined;
}

/**
 * Compute a deterministic machine hash from hostname + homedir.
 *
 * Returns the first MACHINE_HASH_LENGTH hex chars of the SHA-256 digest.
 */
export function computeMachineHash(): string {
  const raw = `${os.hostname()}${os.homedir()}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return hash.slice(0, MACHINE_HASH_LENGTH);
}

/**
 * Invoke `gh api user --jq .login` and return the raw stdout. Bounded by
 * GH_USER_TIMEOUT_MS so a slow/hung `gh` can't stall the synced-write path.
 *
 * Seam: the optional `run` parameter lets tests drive both the present and
 * absent/error branches deterministically without invoking the real `gh`
 * binary (which is otherwise flaky under full-suite contention). Production
 * call sites pass nothing and get the real `execFileSync`.
 */
export type GhRunner = () => string;

const defaultGhRunner: GhRunner = () =>
  execFileSync('gh', ['api', 'user', '--jq', '.login'], {
    encoding: 'utf-8',
    timeout: GH_USER_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

/**
 * Resolve the current GitHub username via the `gh` CLI.
 *
 * Returns FALLBACK_GITHUB_USER if `gh` is not installed, not authenticated,
 * times out, or returns an empty login. This value is only a cosmetic prefix
 * on the machine id — the id's stability comes from the persisted file and the
 * deterministic hash, so a fallback here never corrupts an existing identity.
 */
export function resolveGitHubUser(run: GhRunner = defaultGhRunner): string {
  try {
    const login = run().trim();
    return login.length > 0 ? login : FALLBACK_GITHUB_USER;
  } catch {
    return FALLBACK_GITHUB_USER;
  }
}

/**
 * Get or generate the machine ID for this host.
 *
 * On first call, computes `{github_user}_{machine_hash}` and caches it
 * to `~/.myco/machine_id`. Subsequent calls read from cache.
 *
 * @returns the machine ID string
 */
export function getMachineId(): string {
  // Return the in-memory cached value — avoids a filesystem read per row-insert
  // (getTeamMachineId() delegates here on every synced write when no explicit
  // context has been initialised, so this path can be hot).
  if (cachedMachineId !== undefined) return cachedMachineId;

  const cachePath = resolveMachineIdPath();

  // Read from global cache if present.
  try {
    const persisted = fs.readFileSync(cachePath, 'utf-8').trim();
    if (persisted.length > 0) {
      cachedMachineId = persisted;
      return cachedMachineId;
    }
  } catch {
    // Global cache missing — fall through to generate.
  }

  const githubUser = resolveGitHubUser();
  const machineHash = computeMachineHash();
  const machineId = `${githubUser}_${machineHash}`;

  // Persist for future process startups.
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, machineId, 'utf-8');

  cachedMachineId = machineId;
  return cachedMachineId;
}

/**
 * Propagate a legacy per-project machine_id into the global cache when
 * the global cache is absent. Used by the one-shot global-install
 * migration (plan §5, step "machine_id propagation"): the value the
 * project vault was carrying becomes the machine's canonical id rather
 * than re-deriving and risking divergence from historic capture rows
 * already stamped with the old value.
 *
 * Returns `true` when a value was propagated; `false` when the global
 * cache already exists (so the legacy value is dropped silently — the
 * global cache wins) or when no legacy file exists.
 */
export function propagateLegacyMachineId(vaultDir: string): boolean {
  const globalPath = resolveMachineIdPath();
  if (fs.existsSync(globalPath)) return false;
  const legacyPath = path.join(vaultDir, LEGACY_MACHINE_ID_FILE);
  let legacyValue: string;
  try {
    legacyValue = fs.readFileSync(legacyPath, 'utf-8').trim();
  } catch {
    return false;
  }
  if (legacyValue.length === 0) return false;
  fs.mkdirSync(resolveMycoHome(), { recursive: true });
  fs.writeFileSync(globalPath, legacyValue, 'utf-8');
  return true;
}
