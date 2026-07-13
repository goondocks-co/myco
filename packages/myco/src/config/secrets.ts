/**
 * Secrets file utilities for API key storage outside git.
 *
 * Secrets are stored in `secrets.env` beside the scope they belong to:
 * project legacy vaults, the machine Myco home, or a Grove directory. Project
 * files are gitignored (see VAULT_GITIGNORE), and machine/Grove stores live
 * outside repositories.
 * Format: KEY=value, one per line (same as .env).
 *
 * The Grove rescope widened the blast radius of secrets storage: per-Grove
 * team API keys now live at predictable `~/.myco/groves/<id>/secrets.env`
 * paths. To prevent local user-namespace leakage we enforce restrictive
 * filesystem perms on every write — `0o600` on the file, `0o700` on the
 * containing directory — and tighten any pre-existing files at boot via
 * `tightenSecretsPermissions` (called from `loadSecrets`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

const SECRETS_FILE = 'secrets.env';
const SECRETS_FILE_MODE = 0o600;
const SECRETS_DIR_MODE = 0o700;

/** Read all secrets from <vault>/secrets.env as key-value pairs. */
export function readSecrets(vaultDir: string): Record<string, string> {
  const secretsPath = path.join(vaultDir, SECRETS_FILE);
  if (!fs.existsSync(secretsPath)) return {};

  const secrets: Record<string, string> = {};
  for (const line of fs.readFileSync(secretsPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (match) {
      secrets[match[1]] = match[2];
    }
  }
  return secrets;
}

/**
 * Write a secret to <vault>/secrets.env, preserving existing entries.
 *
 * Both the parent directory and the file are forced to owner-only
 * permissions (0o700 / 0o600) on every write so a sloppy umask cannot
 * leak secrets into the user-readable namespace.
 */
export function writeSecret(vaultDir: string, key: string, value: string): void {
  ensureSecretsDirSecure(vaultDir);
  const secretsPath = path.join(vaultDir, SECRETS_FILE);
  const existing = readSecrets(vaultDir);
  existing[key] = value;

  const content = Object.entries(existing)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';

  writeSecretsFile(secretsPath, content);
}

/**
 * Migrate secrets from a legacy project vault to the machine-wide
 * `~/.myco/secrets.env`. The one-shot global-install migration calls this
 * before deleting the project-vault `secrets.env` so user API keys
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, team tokens) never silently vanish.
 *
 * Semantics:
 * - Reads the legacy project secrets; if none, returns `[]` immediately.
 * - For each key, writes it to `mycoHome/secrets.env` ONLY when the
 *   global file has no entry for that key — the machine-level value
 *   wins on conflict, matching `propagateLegacyMachineId`'s "global is
 *   already canonical" semantics.
 * - Returns the list of keys actually propagated, for audit logging.
 *
 * Permissions are tightened on every write by the underlying
 * `writeSecret`. Idempotent: a second call after migration is a no-op
 * because the global file now has every legacy key.
 */
export function propagateLegacySecrets(vaultDir: string, mycoHome: string): string[] {
  const legacy = readSecrets(vaultDir);
  const keys = Object.keys(legacy);
  if (keys.length === 0) return [];

  const propagated: string[] = [];
  const existing = readSecrets(mycoHome);
  for (const key of keys) {
    if (existing[key] !== undefined) continue;
    writeSecret(mycoHome, key, legacy[key]);
    propagated.push(key);
  }
  return propagated;
}

/**
 * Relocate a legacy project-vault `secrets.env` into the machine-wide
 * `~/.myco/secrets.env` and DELETE the project file. Combines
 * `propagateLegacySecrets` (lift keys, machine value wins on conflict)
 * with an unconditional purge of the project file.
 *
 * Unlike the one-shot global-install migration — which performs the same
 * relocate+purge but is sentinel-gated and runs ONCE per project — this
 * helper is idempotent and safe to call on EVERY daemon boot. The
 * sentinel-gated migration leaves a window open: a project `secrets.env`
 * that materializes AFTER the migration sentinel is written (a hand-placed
 * file, a resurrected branch) is never lifted or purged. The provider-secrets
 * dashboard no longer reads the `project` scope, so such a file becomes an
 * orphaned credential — still consumed by `loadLayeredSecrets` at provider
 * init, yet invisible and undeletable in the UI. Running this at the
 * secrets-load seam closes that window: the project file is relocated to
 * machine secrets (where the dashboard CAN see and delete it) and removed
 * before it can be loaded as a project-scoped fallback.
 *
 * No-op when the project `secrets.env` is absent. Returns the keys lifted
 * (machine-absent keys only); keys already present at machine scope are
 * dropped on purge since the machine value is canonical.
 */
export function relocateLegacyProjectSecrets(vaultDir: string, mycoHome: string): string[] {
  const secretsPath = path.join(vaultDir, SECRETS_FILE);
  if (!fs.existsSync(secretsPath)) return [];
  const propagated = propagateLegacySecrets(vaultDir, mycoHome);
  // Purge the project file regardless of how many keys were lifted: keys
  // already at machine scope are intentionally discarded (machine wins),
  // and lifted keys now live at their canonical home. Best-effort — a
  // failed unlink retries on the next boot.
  try {
    fs.rmSync(secretsPath, { force: true });
  } catch {
    // Leave the file in place; the next boot retries the relocate+purge.
  }
  return propagated;
}

/** Remove one or more secrets from <vault>/secrets.env, preserving remaining entries. */
export function deleteSecrets(vaultDir: string, keys: string[]): void {
  const secretsPath = path.join(vaultDir, SECRETS_FILE);
  if (!fs.existsSync(secretsPath)) return;

  const existing = readSecrets(vaultDir);
  for (const key of keys) delete existing[key];

  const entries = Object.entries(existing);
  if (entries.length === 0) {
    fs.rmSync(secretsPath, { force: true });
    return;
  }

  const content = entries
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';

  ensureSecretsDirSecure(vaultDir);
  writeSecretsFile(secretsPath, content);
}

/**
 * Load secrets from <vault>/secrets.env into process.env (without
 * overwriting existing vars). On the same call we retroactively tighten
 * the file's perms to 0o600 if a pre-Grove install left them looser —
 * see `tightenSecretsPermissions` for the no-op-on-missing semantics.
 */
export function loadSecrets(vaultDir: string): void {
  tightenSecretsPermissions(vaultDir);
  const secrets = readSecrets(vaultDir);
  for (const [key, value] of Object.entries(secrets)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

/**
 * Per-env-object registry of the keys `loadLayeredSecrets` has written,
 * mapped to the exact value it wrote. Ownership is what distinguishes a
 * file-backed secret (which repeated layering must keep in sync with the
 * files — updates AND deletions) from an inherited shell/launchd/boot env
 * var (which layering must never touch). An entry is honored only while the
 * env still holds the recorded value: if any other writer changed or set
 * the key since, ownership is relinquished and the key becomes protected
 * external env like any other. Unobservable-by-design edge: an external
 * writer that sets a key to the EXACT value layering wrote is
 * indistinguishable from layering itself, so ownership is retained and a
 * later file delete removes the key.
 */
const layeredSecretOwnership = new WeakMap<NodeJS.ProcessEnv, Map<string, string>>();

/**
 * Load several secrets.env stores as one layered view.
 *
 * Precedence within a call is low-to-high: later directories override
 * earlier directories (e.g. Grove secrets over machine secrets).
 *
 * Across calls, protection means "not written by layering", not "currently
 * set": env vars that were inherited from the shell/launchd/boot environment
 * (or set by any writer other than this function) are never overwritten and
 * never deleted. Keys THIS function set, however, are refreshed on every
 * call — a value updated in a layered file replaces the env value, and a key
 * that no longer appears in ANY of the layered files is removed from the env
 * entirely. That keeps a long-lived daemon honest about secret rotation and
 * revocation (e.g. the Team page's PUT/DELETE on the served grove's
 * `secrets.env`) without a restart, while an explicit external env var still
 * wins over every file-backed secret exactly as before.
 */
export function loadLayeredSecrets(
  secretsDirs: string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const owned = layeredSecretOwnership.get(env) ?? new Map<string, string>();
  layeredSecretOwnership.set(env, owned);

  // Relinquish ownership of any key whose current env value is no longer
  // the one layering wrote — an external writer took it over, and from here
  // on it is protected exactly like boot env.
  for (const [key, written] of [...owned]) {
    if (env[key] !== written) owned.delete(key);
  }

  const merged: Record<string, string> = {};
  for (const dir of secretsDirs) {
    tightenSecretsPermissions(dir);
    Object.assign(merged, readSecrets(dir));
  }

  // Owned keys that vanished from every layered file: the secret was deleted
  // or rotated away on disk — remove it from the env so a revoked key stops
  // working and a keyless state is observable (missing_key, not stale-ok).
  for (const key of [...owned.keys()]) {
    if (!(key in merged)) {
      delete env[key];
      owned.delete(key);
    }
  }

  for (const [key, value] of Object.entries(merged)) {
    const current = env[key];
    const isExternallySet = current !== undefined && current !== '' && !owned.has(key);
    if (isExternallySet) continue;
    env[key] = value;
    owned.set(key, value);
  }
}

/**
 * Ensure <vault>/secrets.env (when present) is owner-only readable.
 * Idempotent and silent on missing files. Called from `loadSecrets` so
 * every daemon boot performs the retroactive chmod even on machines
 * that wrote their secrets before the perms tightening landed.
 *
 * On non-POSIX platforms (Windows) `fs.chmod` is a no-op for the bits
 * we care about; we rely on NTFS ACLs there and skip without erroring.
 */
export function tightenSecretsPermissions(vaultDir: string): void {
  const secretsPath = path.join(vaultDir, SECRETS_FILE);
  try {
    const stat = fs.statSync(secretsPath);
    const currentMode = stat.mode & 0o777;
    if (currentMode !== SECRETS_FILE_MODE) {
      fs.chmodSync(secretsPath, SECRETS_FILE_MODE);
    }
  } catch (err) {
    // Missing file is the common no-op case; permission errors get
    // swallowed silently because the secrets file is per-user and the
    // daemon can't recover from an unreadable parent directory anyway.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Best-effort only — we don't want a chmod failure to crash the
      // daemon; the secret will simply remain at its existing perms.
    }
  }
  try {
    fs.chmodSync(vaultDir, SECRETS_DIR_MODE);
  } catch {
    // Same rationale as above.
  }
}

function ensureSecretsDirSecure(vaultDir: string): void {
  fs.mkdirSync(vaultDir, { recursive: true, mode: SECRETS_DIR_MODE });
  // mkdir with `recursive: true` does not chmod existing leaf
  // directories on POSIX, so apply the tightening explicitly.
  try {
    fs.chmodSync(vaultDir, SECRETS_DIR_MODE);
  } catch {
    // Non-POSIX or read-only filesystem; ignore.
  }
}

function writeSecretsFile(secretsPath: string, content: string): void {
  // Atomic write protects against torn writes; the mode-aware helper
  // applies 0o600 to the tempfile before rename so the final path is
  // never briefly readable at the default umask.
  atomicWriteFileSync(secretsPath, content, { encoding: 'utf-8', mode: SECRETS_FILE_MODE });
}
