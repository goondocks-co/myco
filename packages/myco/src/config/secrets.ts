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
import { createHash, randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';
import { resolvePerUserLocksDir } from '@myco/utils/user-lock-root.js';

export const SECRETS_FILE = 'secrets.env';
const SECRETS_FILE_MODE = 0o600;
const SECRETS_DIR_MODE = 0o700;

function canonicalDirectory(target: string): string {
  let current = path.resolve(target);
  const unresolved: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    unresolved.unshift(path.basename(current));
    current = parent;
  }
  try {
    current = fs.realpathSync(current);
  } catch {
    // The process will surface the real filesystem error when the transaction
    // attempts its actual read or write.
  }
  const resolved = path.join(current, ...unresolved);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Stable external lock identity for one secrets store. The lock root is tied
 * to the operating-system account rather than TMPDIR, HOME, or MYCO_HOME, so
 * sibling Myco installs and processes with different temporary directories
 * still coordinate. The key is the canonical vault directory plus the literal
 * secrets filename; replacing an exact-file symlink cannot change it.
 */
function secretStoreLockPath(vaultDir: string): string {
  const lockDir = path.join(resolvePerUserLocksDir(), 'secrets');
  fs.mkdirSync(lockDir, { recursive: true, mode: SECRETS_DIR_MODE });
  try { fs.chmodSync(lockDir, SECRETS_DIR_MODE); } catch { /* platform ACLs apply */ }
  const storePath = path.join(canonicalDirectory(vaultDir), SECRETS_FILE);
  const key = createHash('sha256').update(storePath).digest('hex');
  return path.join(lockDir, `${key}.lock`);
}

function withSecretsTransaction<T>(vaultDir: string, fn: () => T): T {
  return withSecretsTransactions([vaultDir], fn);
}

function withSecretsTransactions<T>(vaultDirs: readonly string[], fn: () => T): T {
  const RETRY = Symbol('retry-secret-locks');
  const MAX_LOCK_RETRIES = 8;
  for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt += 1) {
    const locks = [...new Set(vaultDirs.map(secretStoreLockPath))].sort();
    const run = (index: number): T | typeof RETRY => {
      if (index < locks.length) return withFileLockSync(locks[index]!, () => run(index + 1));
      const freshLocks = [...new Set(vaultDirs.map(secretStoreLockPath))].sort();
      if (freshLocks.length !== locks.length || freshLocks.some((lock, i) => lock !== locks[i])) return RETRY;
      return fn();
    };
    const result = run(0);
    if (result !== RETRY) return result;
  }
  throw new Error('Secret store identity did not stabilize while acquiring locks');
}

export class InvalidSecretValueError extends Error {
  readonly code = 'invalid_secret_value';

  constructor(readonly field: 'key' | 'value' | 'entry') {
    super(`Secret ${field} contains unsupported characters`);
    this.name = 'InvalidSecretValueError';
  }
}

export function assertValidSecretEntry(key: unknown, value: unknown): void {
  if (typeof key !== 'string' || key.length === 0 || /[\0\r\n=]/.test(key)) {
    throw new InvalidSecretValueError('key');
  }
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) {
    throw new InvalidSecretValueError('value');
  }
}

/** Read all secrets from <vault>/secrets.env as key-value pairs. */
export function readSecrets(vaultDir: string): Record<string, string> {
  const secretsPath = path.join(vaultDir, SECRETS_FILE);
  if (!fs.existsSync(secretsPath)) return Object.create(null) as Record<string, string>;
  return readSecretsFile(secretsPath);
}

/** Decode one exact secret file path. Callers that mutate the file must hold its store transaction. */
export function readSecretsFile(secretsPath: string): Record<string, string> {
  return decodeSecrets(decodeSecretBuffer(fs.readFileSync(secretsPath)));
}

/**
 * Write a secret to <vault>/secrets.env, preserving existing entries.
 *
 * Both the parent directory and the file are forced to owner-only
 * permissions (0o700 / 0o600) on every write so a sloppy umask cannot
 * leak secrets into the user-readable namespace.
 */
export function writeSecret(vaultDir: string, key: string, value: string): void {
  assertValidSecretEntry(key, value);
  withSecretsTransaction(vaultDir, () => {
    assertMutableSecretsPath(vaultDir);
    const existing = readSecrets(vaultDir);
    existing[key] = value;
    persistSecretsUnlocked(vaultDir, existing);
  });
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
  return withSecretsTransaction(vaultDir, () => {
    assertMutableSecretsPath(vaultDir);
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
      return { value: adoptMintedSecretUnlocked(vaultDir, key, claimPath), minted: false };
    }

    try {
      const merged = readSecrets(vaultDir);
      merged[key] = candidate;
      persistSecretsUnlocked(vaultDir, merged);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
      try { fs.rmSync(claimPath, { force: true }); } catch { /* best-effort */ }
    }
    return { value: candidate, minted: true };
  });
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
function adoptMintedSecretUnlocked(vaultDir: string, key: string, claimPath: string): string {
  const fromSecrets = readSecrets(vaultDir)[key];
  if (fromSecrets && fromSecrets.trim()) return fromSecrets.trim();

  let rawClaim: string | undefined;
  try {
    rawClaim = fs.readFileSync(claimPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (rawClaim !== undefined) assertValidSecretEntry(key, rawClaim);
  const fromClaim = rawClaim?.trim() ?? '';
  if (fromClaim) {
    const recheck = readSecrets(vaultDir)[key];
    if (!recheck || !recheck.trim()) {
      const merged = readSecrets(vaultDir);
      merged[key] = fromClaim;
      persistSecretsUnlocked(vaultDir, merged);
    }
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
 * Permissions are tightened on every persisted write. Idempotent: a second
 * call after migration is a no-op
 * because the global file now has every legacy key.
 */
export function propagateLegacySecrets(vaultDir: string, mycoHome: string): string[] {
  return withSecretsTransactions([vaultDir, mycoHome], () => propagateLegacySecretsUnlocked(vaultDir, mycoHome));
}

function propagateLegacySecretsUnlocked(vaultDir: string, mycoHome: string): string[] {
  const legacy = readSecrets(vaultDir);
  const legacyEntries = Object.entries(legacy);
  if (legacyEntries.length === 0) return [];

  const existing = readSecrets(mycoHome);
  const merged = Object.assign(Object.create(null) as Record<string, string>, existing);
  const propagated: string[] = [];
  for (const [key, value] of legacyEntries) {
    if (merged[key] !== undefined) continue;
    merged[key] = value;
    propagated.push(key);
  }
  if (propagated.length > 0) {
    assertMutableSecretsPath(mycoHome);
    persistSecretsUnlocked(mycoHome, merged);
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
  if (secretStoreLockPath(vaultDir) === secretStoreLockPath(mycoHome)) return [];
  return withSecretsTransactions([vaultDir, mycoHome], () => {
    if (!fs.existsSync(secretsPath)) return [];
    assertMutableSecretsPath(vaultDir);
    const propagated = propagateLegacySecretsUnlocked(vaultDir, mycoHome);
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
  });
}

/** Remove one or more secrets from <vault>/secrets.env, preserving remaining entries. */
export function deleteSecrets(vaultDir: string, keys: string[]): void {
  for (const key of keys) assertValidSecretEntry(key, '');
  withSecretsTransaction(vaultDir, () => {
    const secretsPath = path.join(vaultDir, SECRETS_FILE);
    if (!fs.existsSync(secretsPath)) return;
    assertMutableSecretsPath(vaultDir);

    const existing = readSecrets(vaultDir);
    for (const key of keys) delete existing[key];

    if (Object.keys(existing).length === 0) {
      fs.rmSync(secretsPath, { force: true });
      return;
    }
    persistSecretsUnlocked(vaultDir, existing);
  });
}

/**
 * Load secrets from <vault>/secrets.env into process.env (without
 * overwriting existing vars). On the same call we retroactively tighten
 * the file's perms to 0o600 if a pre-Grove install left them looser —
 * see `tightenSecretsPermissions` for the no-op-on-missing semantics.
 */
export function loadSecrets(vaultDir: string): void {
  const secrets = readSecrets(vaultDir);
  tightenSecretsPermissions(vaultDir);
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
  const stores = secretsDirs.map((dir) => ({ dir, secrets: readSecrets(dir) }));
  for (const { dir } of stores) tightenSecretsPermissions(dir);

  const owned = layeredSecretOwnership.get(env) ?? new Map<string, string>();
  layeredSecretOwnership.set(env, owned);

  // Relinquish ownership of any key whose current env value is no longer
  // the one layering wrote — an external writer took it over, and from here
  // on it is protected exactly like boot env.
  for (const [key, written] of [...owned]) {
    if (env[key] !== written) owned.delete(key);
  }

  const merged = Object.create(null) as Record<string, string>;
  for (const { secrets } of stores) {
    Object.assign(merged, secrets);
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
  withSecretsTransaction(vaultDir, () => tightenSecretsPermissionsUnlocked(vaultDir));
}

function tightenSecretsPermissionsUnlocked(vaultDir: string): void {
  readSecrets(vaultDir);
  const secretsPath = path.join(vaultDir, SECRETS_FILE);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(secretsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (stat !== undefined && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new Error(`Refusing to harden non-regular secret store: ${secretsPath}`);
  }
  try {
    if (stat !== undefined) {
      const currentMode = stat.mode & 0o777;
      if (currentMode !== SECRETS_FILE_MODE) {
        fs.chmodSync(secretsPath, SECRETS_FILE_MODE);
      }
    }
  } catch {
    // Boot-time permission repair is best-effort on unsupported filesystems.
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

function assertMutableSecretsPath(vaultDir: string): void {
  const secretsPath = path.join(vaultDir, SECRETS_FILE);
  try {
    const stat = fs.lstatSync(secretsPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Refusing to mutate non-regular secret store: ${secretsPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function decodeSecretBuffer(content: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new InvalidSecretValueError('entry');
  }
}

function decodeSecrets(content: unknown): Record<string, string> {
  if (typeof content !== 'string' || /\0/.test(content)) {
    throw new InvalidSecretValueError('entry');
  }

  // Normalize only CRLF record delimiters. A remaining CR is bare or embedded
  // in a key/value and therefore cannot become valid through line splitting.
  const normalized = content.replace(/\r\n/g, '\n');
  if (/\r/.test(normalized)) throw new InvalidSecretValueError('entry');

  const secrets = Object.create(null) as Record<string, string>;
  for (const line of normalized.split('\n')) {
    if (line.trim().length === 0 || /^\s*#/.test(line)) continue;
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (!match) throw new InvalidSecretValueError('entry');
    const [, key, value] = match;
    assertValidSecretEntry(key, value);
    secrets[key] = value;
  }
  return secrets;
}

function encodeSecrets(secrets: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(secrets);
  for (const [key, value] of entries) {
    assertValidSecretEntry(key, value);
  }
  return entries.map(([key, value]) => `${key}=${value as string}`).join('\n') + '\n';
}

function persistSecretsUnlocked(vaultDir: string, secrets: Readonly<Record<string, string>>): void {
  const content = encodeSecrets(secrets);
  ensureSecretsDirSecure(vaultDir);
  writeSecretsFile(path.join(vaultDir, SECRETS_FILE), content);
}

const LEGACY_TEAM_SECRET_BACKUP_FILE = `${SECRETS_FILE}.bak-pre-myco-team`;

export interface LegacyTeamSecretReconcilePair {
  sourceVaultDir: string;
  destinationVaultDir: string;
}

export type LegacyTeamSecretDisposition = 'copied' | 'conflicted' | 'noop';
export type LegacyTeamSecretFinalizerOutcome = 'complete' | 'deferred';

export interface LegacyTeamSecretReconcileResult {
  dispositions: LegacyTeamSecretDisposition[];
  outcome: LegacyTeamSecretFinalizerOutcome;
}

interface SecretSnapshot {
  path: string;
  vaultDir: string;
  raw: Buffer | null;
}

interface LegacyTeamSecretPlan {
  source: SecretSnapshot;
  destination: SecretSnapshot;
  backup: SecretSnapshot;
  disposition: LegacyTeamSecretDisposition;
}

/**
 * Reconcile the fixed secret snapshots used by legacy Team-home retirement,
 * then run a synchronous topology finalizer while every affected store lock
 * remains held.
 */
export function withLegacyTeamSecretSnapshotsReconciledSync(
  pairs: readonly LegacyTeamSecretReconcilePair[],
  finalizer: () => LegacyTeamSecretFinalizerOutcome,
): LegacyTeamSecretReconcileResult {
  assertLegacyTeamSecretPairs(pairs);
  if (finalizer.constructor.name === 'AsyncFunction') {
    throw new TypeError('Legacy Team secret finalizer must be synchronous');
  }
  return withSecretsTransactions(
    pairs.flatMap((pair) => [pair.sourceVaultDir, pair.destinationVaultDir]),
    () => {
      const plans = planLegacyTeamSecretReconciliation(pairs);
      for (const plan of plans) {
        for (const snapshot of [plan.source, plan.destination, plan.backup]) {
          if (snapshot.raw !== null) persistStrictSecretSnapshot(snapshot);
        }
      }
      for (const plan of plans) {
        if (plan.source.raw === null) continue;
        if (plan.disposition === 'copied') {
          persistStrictSecretSnapshot({ ...plan.destination, raw: plan.source.raw });
        } else if (plan.disposition === 'conflicted' && plan.backup.raw === null) {
          persistStrictSecretSnapshot({ ...plan.backup, raw: plan.source.raw });
        }
      }
      const outcome = finalizer();
      if (typeof (outcome as { then?: unknown } | null)?.then === 'function') {
        throw new TypeError('Legacy Team secret finalizer must be synchronous');
      }
      if (outcome !== 'complete' && outcome !== 'deferred') {
        throw new TypeError('Legacy Team secret finalizer returned an invalid outcome');
      }
      return { dispositions: plans.map((plan) => plan.disposition), outcome };
    },
  );
}

function assertLegacyTeamSecretPairs(pairs: readonly LegacyTeamSecretReconcilePair[]): void {
  const stores = new Set<string>();
  for (const value of pairs as readonly unknown[]) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Legacy Team secret pair must be an object');
    }
    const pair = value as Record<string, unknown>;
    const keys = Object.keys(pair).sort();
    if (keys.length !== 2 || keys[0] !== 'destinationVaultDir' || keys[1] !== 'sourceVaultDir'
      || typeof pair.sourceVaultDir !== 'string' || typeof pair.destinationVaultDir !== 'string') {
      throw new TypeError('Legacy Team secret pair has unsupported fields');
    }
    const sourceIdentity = secretStoreLockPath(pair.sourceVaultDir);
    const destinationIdentity = secretStoreLockPath(pair.destinationVaultDir);
    if (sourceIdentity === destinationIdentity) {
      throw new Error('Legacy Team secret source and destination must be different stores');
    }
    if (stores.has(sourceIdentity) || stores.has(destinationIdentity)) {
      throw new Error('Legacy Team secret pairs must use distinct stores');
    }
    stores.add(sourceIdentity);
    stores.add(destinationIdentity);
  }
}

function planLegacyTeamSecretReconciliation(
  pairs: readonly LegacyTeamSecretReconcilePair[],
): LegacyTeamSecretPlan[] {
  return pairs.map((pair) => {
    const source = readRegularSecretSnapshot(pair.sourceVaultDir, SECRETS_FILE);
    const destination = readRegularSecretSnapshot(pair.destinationVaultDir, SECRETS_FILE);
    const backup = readRegularSecretSnapshot(pair.destinationVaultDir, LEGACY_TEAM_SECRET_BACKUP_FILE);

    let disposition: LegacyTeamSecretDisposition = 'noop';
    if (source.raw !== null && destination.raw === null) {
      disposition = 'copied';
    } else if (source.raw !== null && destination.raw !== null && !source.raw.equals(destination.raw)) {
      disposition = 'conflicted';
      if (backup.raw !== null && !backup.raw.equals(source.raw)) {
        throw new Error(`Refusing to overwrite divergent legacy Team secret backup: ${backup.path}`);
      }
    }
    return { source, destination, backup, disposition };
  });
}

function readRegularSecretSnapshot(vaultDir: string, fileName: string): SecretSnapshot {
  const snapshotPath = path.join(vaultDir, fileName);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(snapshotPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: snapshotPath, vaultDir, raw: null };
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing non-regular legacy Team secret snapshot: ${snapshotPath}`);
  }
  const raw = fs.readFileSync(snapshotPath);
  decodeSecrets(decodeSecretBuffer(raw));
  return { path: snapshotPath, vaultDir, raw };
}

function persistStrictSecretSnapshot(snapshot: SecretSnapshot): void {
  if (snapshot.raw === null) throw new Error('Cannot persist an absent secret snapshot');
  decodeSecrets(decodeSecretBuffer(snapshot.raw));
  ensureStrictSecretsDir(snapshot.vaultDir);
  writeSecretsFile(snapshot.path, snapshot.raw);
  if (process.platform !== 'win32') {
    fs.chmodSync(snapshot.path, SECRETS_FILE_MODE);
    fs.chmodSync(snapshot.vaultDir, SECRETS_DIR_MODE);
  }
  const fileStat = fs.lstatSync(snapshot.path);
  const dirStat = fs.lstatSync(snapshot.vaultDir);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()
    || (process.platform !== 'win32' && (fileStat.mode & 0o777) !== SECRETS_FILE_MODE)) {
    throw new Error(`Legacy Team secret snapshot is not a private regular file: ${snapshot.path}`);
  }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()
    || (process.platform !== 'win32' && (dirStat.mode & 0o777) !== SECRETS_DIR_MODE)) {
    throw new Error(`Legacy Team secret directory is not private: ${snapshot.vaultDir}`);
  }
}

function ensureStrictSecretsDir(vaultDir: string): void {
  try {
    const stat = fs.lstatSync(vaultDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing non-regular legacy Team secret directory: ${vaultDir}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fs.mkdirSync(vaultDir, { recursive: true, mode: SECRETS_DIR_MODE });
  }
}

function writeSecretsFile(secretsPath: string, content: string | Buffer): void {
  // Atomic write protects against torn writes; the mode-aware helper
  // applies 0o600 to the tempfile before rename so the final path is
  // never briefly readable at the default umask.
  atomicWriteFileSync(secretsPath, content, { encoding: 'utf-8', mode: SECRETS_FILE_MODE });
}
