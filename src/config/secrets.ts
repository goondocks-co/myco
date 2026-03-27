/**
 * Secrets file utilities for API key storage outside git.
 *
 * Secrets are stored in `secrets.env` inside the vault directory.
 * This file is gitignored (see VAULT_GITIGNORE) and never committed.
 * Format: KEY=value, one per line (same as .env).
 */
import fs from 'node:fs';
import path from 'node:path';

const SECRETS_FILE = 'secrets.env';

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

/** Write a secret to <vault>/secrets.env, preserving existing entries. */
export function writeSecret(vaultDir: string, key: string, value: string): void {
  const secretsPath = path.join(vaultDir, SECRETS_FILE);
  const existing = readSecrets(vaultDir);
  existing[key] = value;

  const content = Object.entries(existing)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';

  fs.writeFileSync(secretsPath, content, 'utf-8');
}

/** Load secrets from <vault>/secrets.env into process.env (without overwriting existing vars). */
export function loadSecrets(vaultDir: string): void {
  const secrets = readSecrets(vaultDir);
  for (const [key, value] of Object.entries(secrets)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
