/**
 * Secrets file utilities for API key storage outside git.
 *
 * Secrets are stored in `secrets.env` inside the vault directory.
 * This file is gitignored (see VAULT_GITIGNORE) and never committed.
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
  fs.writeFileSync(secretsPath, content, { encoding: 'utf-8', mode: SECRETS_FILE_MODE });
  // writeFileSync only applies the mode when creating the file. If it
  // already existed, force the tightening explicitly.
  try {
    fs.chmodSync(secretsPath, SECRETS_FILE_MODE);
  } catch {
    // Best-effort.
  }
}
