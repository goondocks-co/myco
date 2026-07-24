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
import { randomBytes } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

const SECRETS_FILE = 'secrets.env';
const SECRETS_FILE_MODE = 0o600;
const SECRETS_DIR_MODE = 0o700;

export class InvalidSecretValueError extends Error {
  readonly code = 'invalid_secret_value';

  constructor(readonly field: 'key' | 'value') {
    super(`Secret ${field} contains unsupported characters`);
    this.name = 'InvalidSecretValueError';
  }
}

export function assertValidSecretEntry(key: string, value: string): void {
  if (key.length === 0 || /[\0\r\n=]/.test(key)) {
    throw new InvalidSecretValueError('key');
  }
  if (/[\0\r\n]/.test(value)) {
    throw new InvalidSecretValueError('value');
  }
}

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
  const existing = readSecrets(vaultDir);
  existing[key] = value;
  persistSecrets(vaultDir, existing);
}

/** Outcome of {@link writeSecretIfAbsent}. */
export interface MintIfAbsentResult {
  /** The value now stored under `key` — the winner's, always. A concurrent
   *  minter that LOST the race receives the winner's stored value here, never
   *  its own discarded candidate. */
  value: string;
  /** True iff THIS call minted the stored value; false when it adopted a
   *  value another writer had already stored (or concurrently minted). The
   *  external-MCP toggle's one-time raw-token reveal keys off this. */
  minted: boolean;
}

/** Suffix for the per-key mint-claim file that arbitrates a cross-process
 *  mint race. Lives beside secrets.env; never matched by {@link readSecrets},
 *  which reads only the exact `secrets.env` filename. */
const MINT_CLAIM_SUFFIX = '.mint-claim';

function mintClaimPath(vaultDir: string, key: string): string {
  const safeKey = key.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(vaultDir, `${SECRETS_FILE}.${safeKey}${MINT_CLAIM_SUFFIX}`);
}

/**
 * Mint a secret for `key` exactly once, safe against a CROSS-PROCESS race.
 *
 * A plain read→mint→{@link writeSecret} cannot survive two daemon processes
 * (a restart overlap, or a CLI-and-daemon pair) both minting the same key:
 * both read the key absent, both mint a DIFFERENT random value, and the
 * second whole-file write clobbers the first — the two processes then
 * disagree about the stored token, and whichever already handed its value to
 * a member (a host serve-bearer, an external-MCP token) handed out one the
 * persisted file no longer holds. (In-process the callers are fully
 * synchronous read-to-write, so the race is purely cross-process.)
 *
 * The arbiter is an atomic create-exclusive of a per-key claim file that
 * already HOLDS the candidate value: the candidate is written to a private
 * tempfile, then hard-linked into the claim path. `link(2)` fails EEXIST if a
 * concurrent minter already created the claim, so exactly one candidate ever
 * wins, and the claim holds that value the instant it exists (no empty-file
 * window a loser could observe between create and first write). The winner
 * merges its value into secrets.env before releasing the claim; a loser reads
 * the winner's value out of secrets.env — or out of the still-present claim,
 * if the winner hasn't merged yet (or crashed mid-mint, in which case the
 * loser persists the claimed value so a keyless state can never result). The
 * function therefore always returns the value that is (or is about to be) the
 * single stored one — never a losing minter's orphaned candidate.
 *
 * `mint` is a thunk so a fresh random value is generated only when this call
 * actually needs a candidate (never on the fast path).
 */
export function writeSecretIfAbsent(
  vaultDir: string,
  key: string,
  mint: () => string,
): MintIfAbsentResult {
  assertValidSecretEntry(key, '');

  // Fast path: a completed prior mint already sits in secrets.env.
  const existing = readSecrets(vaultDir)[key];
  if (existing && existing.trim()) {
    ensureSecretsDirSecure(vaultDir);
    return { value: existing.trim(), minted: false };
  }

  const claimPath = mintClaimPath(vaultDir, key);
  const candidate = mint();
  assertValidSecretEntry(key, candidate);
  ensureSecretsDirSecure(vaultDir);
  const tmp = `${claimPath}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`;
  fs.writeFileSync(tmp, candidate, { encoding: 'utf-8', mode: SECRETS_FILE_MODE });

  try {
    // Atomic create-with-content: link fails EEXIST if a concurrent minter
    // already claimed. On success the claim holds our candidate atomically —
    // no empty-file window between create and write for a loser to observe.
    fs.linkSync(tmp, claimPath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Lost the race — adopt the winner's value.
    return { value: adoptMintedSecret(vaultDir, key, claimPath), minted: false };
  }

  // Won the race. Merge into secrets.env (the canonical store) BEFORE
  // releasing the claim, so a losing minter always finds the value in at
  // least one of {claim, secrets.env}.
  try {
    writeSecret(vaultDir, key, candidate);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(claimPath, { force: true }); } catch { /* best-effort */ }
  }
  return { value: candidate, minted: true };
}

/**
 * Adopt the value a concurrent minter won the claim with. Prefers the
 * canonical secrets.env; falls back to the claim file (the winner may not
 * have merged yet, or may have crashed after claiming but before merging — in
 * which case this call persists the claimed value so the canonical store
 * still ends up holding it). The winner merges secrets.env BEFORE releasing
 * the claim, so the value is present in at least one of {claim, secrets.env}
 * for the whole window a loser can observe; the final throw is defensive only.
 */
function adoptMintedSecret(vaultDir: string, key: string, claimPath: string): string {
  const fromSecrets = readSecrets(vaultDir)[key];
  if (fromSecrets && fromSecrets.trim()) return fromSecrets.trim();

  let fromClaim = '';
  try { fromClaim = fs.readFileSync(claimPath, 'utf-8').trim(); } catch { /* claim released after a merge */ }
  if (fromClaim) {
    const recheck = readSecrets(vaultDir)[key];
    if (!recheck || !recheck.trim()) writeSecret(vaultDir, key, fromClaim);
    return fromClaim;
  }

  // Claim already released — the winner merged between our two secrets reads.
  const settled = readSecrets(vaultDir)[key];
  if (settled && settled.trim()) return settled.trim();

  throw new Error(
    `writeSecretIfAbsent: lost the mint race for ${key} but neither the claim nor secrets.env holds a value`,
  );
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

  if (Object.keys(existing).length === 0) {
    fs.rmSync(secretsPath, { force: true });
    return;
  }
  persistSecrets(vaultDir, existing);
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

function encodeSecrets(secrets: Readonly<Record<string, string>>): string {
  const entries = Object.entries(secrets);
  for (const [key, value] of entries) {
    assertValidSecretEntry(key, value);
  }
  return entries.map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

function persistSecrets(vaultDir: string, secrets: Readonly<Record<string, string>>): void {
  const content = encodeSecrets(secrets);
  ensureSecretsDirSecure(vaultDir);
  writeSecretsFile(path.join(vaultDir, SECRETS_FILE), content);
}

function writeSecretsFile(secretsPath: string, content: string): void {
  // Atomic write protects against torn writes; the mode-aware helper
  // applies 0o600 to the tempfile before rename so the final path is
  // never briefly readable at the default umask.
  atomicWriteFileSync(secretsPath, content, { encoding: 'utf-8', mode: SECRETS_FILE_MODE });
}
