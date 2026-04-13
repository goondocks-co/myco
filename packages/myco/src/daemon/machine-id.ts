/**
 * Machine identity generation — deterministic `{github_user}_{machine_hash}` format.
 *
 * The machine ID uniquely identifies a (user, machine) pair for backup dedup
 * and team sync. It is computed once, cached to `{vaultDir}/machine_id`,
 * and reused on subsequent calls.
 *
 * Format: `{github_user}_{machine_hash}` where machine_hash is a truncated
 * SHA-256 of `os.hostname() + os.homedir()`.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Length of the truncated machine hash suffix. */
const MACHINE_HASH_LENGTH = 8;

/** Filename for the cached machine ID within the vault. */
const MACHINE_ID_FILE = 'machine_id';

/** Fallback GitHub username when `gh` CLI is unavailable. */
const FALLBACK_GITHUB_USER = 'local';

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
 * Resolve the current GitHub username via the `gh` CLI.
 *
 * Returns FALLBACK_GITHUB_USER if `gh` is not installed or not authenticated.
 */
export function resolveGitHubUser(): string {
  try {
    const output = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const login = output.trim();
    return login.length > 0 ? login : FALLBACK_GITHUB_USER;
  } catch {
    return FALLBACK_GITHUB_USER;
  }
}

/**
 * Get or generate the machine ID for this vault.
 *
 * On first call, computes `{github_user}_{machine_hash}` and caches it
 * to `{vaultDir}/machine_id`. Subsequent calls read from cache.
 *
 * @param vaultDir — vault root directory (e.g., `~/.myco/vaults/myco/`)
 * @returns the machine ID string
 */
export function getMachineId(vaultDir: string): string {
  const cachePath = path.join(vaultDir, MACHINE_ID_FILE);

  // Read from cache if present
  try {
    const cached = fs.readFileSync(cachePath, 'utf-8').trim();
    if (cached.length > 0) return cached;
  } catch {
    // File doesn't exist yet — fall through to generate
  }

  const githubUser = resolveGitHubUser();
  const machineHash = computeMachineHash();
  const machineId = `${githubUser}_${machineHash}`;

  // Cache for future calls
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(cachePath, machineId, 'utf-8');

  return machineId;
}
