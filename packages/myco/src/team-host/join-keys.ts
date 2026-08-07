/**
 * Join keys — the admission gate for the public enrollment route.
 *
 * A member proves it was invited by presenting a key the HOST minted, IN the
 * request, which this daemon validates. There is no network membership standing
 * behind that check: the enrollment route is published to the internet, so the
 * key is the entire admission gate.
 *
 * PROPERTIES, each load-bearing on a route published to the internet:
 *   - 256 bits of entropy. Nothing rate-limits a guess into existence.
 *   - HASHED AT REST. The file is readable by the host's own user; a key that
 *     leaks from it must not be replayable, so only the SHA-256 lives on disk
 *     and the raw value exists exactly twice — the mint reveal and the
 *     member's one enrollment request.
 *   - SINGLE USE, consumed inside the same lock that validates it, so two
 *     racing enrollments cannot both spend one key.
 *   - EXPIRING, because an unused invitation left in a chat log should stop
 *     working on its own.
 *
 * Storage is one small JSON file under the host control dir, written atomically
 * — keys are few and short-lived, so a file per key would buy nothing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/lifecycle-lock.js';
import { resolveHostControlDir } from '../grove/paths.js';

/** Filename under {@link resolveHostControlDir}. */
export const JOIN_KEYS_FILENAME = 'join-keys.json';

/** Bytes of entropy in a join key. 32 = 256 bits (§3 ⚠). */
const JOIN_KEY_BYTES = 32;

/** Default lifetime for a freshly minted key. Short on purpose: an invitation
 *  is handed over in the moment, and one that outlives the conversation is a
 *  standing credential nobody remembers issuing. */
export const DEFAULT_JOIN_KEY_TTL_MS = 60 * 60 * 1000;

/** Keys are pruned once they are this far past being useful — consumed or
 *  expired — so the file cannot grow without bound. Kept well beyond the TTL
 *  so `list` can still show an operator what recently happened. */
const JOIN_KEY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** A key as it exists on disk. The raw value is NEVER stored. */
export interface JoinKeyRecord {
  id: string;
  /** SHA-256 of the raw key, hex. */
  hash: string;
  created_at: string;
  expires_at: string;
  /** Set once the key has been spent; a key with this set never validates. */
  used_at?: string;
  /** The machine_id that spent it — operator-facing provenance. */
  used_by?: string;
  /** Set when an operator revokes an unused key. */
  revoked_at?: string;
}

interface JoinKeyFile {
  schema_version: 1;
  keys: JoinKeyRecord[];
}

const EMPTY: JoinKeyFile = { schema_version: 1, keys: [] };

export function joinKeysPath(): string {
  return path.join(resolveHostControlDir(), JOIN_KEYS_FILENAME);
}

/**
 * Serialize every read-modify-write on this file.
 *
 * The operations here are synchronous, so they cannot interleave WITHIN a
 * process — but the store lives under the machine-global team home, which is
 * shared by every daemon on the box (the two-MYCO_HOME dogfood setup runs two).
 * Without a lock, two processes can both read a key as unused and both spend
 * it, which defeats single-use, or a mint can clobber a concurrent consume and
 * silently resurrect a spent key. Same discipline the host registry uses, for
 * the same reason.
 */
function withJoinKeysLock<T>(fn: () => T): T {
  const dir = resolveHostControlDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withFileLockSync(path.join(dir, `${JOIN_KEYS_FILENAME}.lock`), fn);
}

function readFile(): JoinKeyFile {
  let raw: string;
  try {
    raw = fs.readFileSync(joinKeysPath(), 'utf-8');
  } catch {
    return { ...EMPTY, keys: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<JoinKeyFile>;
    if (!Array.isArray(parsed.keys)) return { ...EMPTY, keys: [] };
    // Drop anything structurally wrong rather than throwing: a corrupt entry
    // must not make every future enrollment fail closed on a parse error.
    const keys = parsed.keys.filter((k): k is JoinKeyRecord =>
      Boolean(k) && typeof k === 'object'
      && typeof (k as JoinKeyRecord).id === 'string'
      && typeof (k as JoinKeyRecord).hash === 'string'
      && typeof (k as JoinKeyRecord).expires_at === 'string');
    return { schema_version: 1, keys };
  } catch {
    return { ...EMPTY, keys: [] };
  }
}

function writeFile(file: JoinKeyFile): void {
  const dir = resolveHostControlDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 0600: the file holds key HASHES, not raw keys, but it is still the record
  // of who may join and there is no reason for it to be group-readable.
  atomicWriteFileSync(joinKeysPath(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, durable: true });
}

function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf-8').digest('hex');
}

/** Drop records that are consumed/expired past the retention window. */
function prune(keys: JoinKeyRecord[], now: number): JoinKeyRecord[] {
  return keys.filter((k) => {
    const settledAt = k.used_at ?? k.revoked_at;
    if (settledAt) return now - Date.parse(settledAt) < JOIN_KEY_RETENTION_MS;
    return now - Date.parse(k.expires_at) < JOIN_KEY_RETENTION_MS;
  });
}

/** Shortest key an operator can mint. Below this the key expires before it can
 *  be read out of the UI and handed over — `'0m'` mints one that is already
 *  dead. */
export const MIN_JOIN_KEY_TTL_MS = 60_000;
/** Longest. A join key is a bearer credential that mints another credential;
 *  `'3650d'` is a standing invitation, not an expiring one. */
export const MAX_JOIN_KEY_TTL_MS = 7 * 86_400_000;

/** Parse the operator's `expiration` (`'30m'`, `'2h'`, `'1d'`) into ms,
 *  CLAMPED to a usable window. Falls back to the module default rather than
 *  throwing — an unparseable value should mint a short-lived key, not fail the
 *  invite. */
export function parseJoinKeyTtlMs(expiration: string): number {
  const match = expiration.match(/^(\d+)\s*([mhd])$/i);
  if (!match) return DEFAULT_JOIN_KEY_TTL_MS;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const scale = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return Math.min(Math.max(value * scale, MIN_JOIN_KEY_TTL_MS), MAX_JOIN_KEY_TTL_MS);
}

export interface MintedJoinKey {
  id: string;
  /** The RAW key. Returned once, never stored, never logged. */
  key: string;
  expires_at: string;
}

/**
 * Mint a join key and return the raw value ONCE.
 *
 * The caller is responsible for getting it to the member and forgetting it —
 * this module keeps only the hash, so a lost key cannot be recovered, only
 * replaced.
 */
export function mintJoinKey(opts: { ttlMs?: number; now?: () => number } = {}): MintedJoinKey {
  const now = opts.now?.() ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_JOIN_KEY_TTL_MS;
  const raw = crypto.randomBytes(JOIN_KEY_BYTES).toString('base64url');
  const record: JoinKeyRecord = {
    id: crypto.randomUUID(),
    hash: hashKey(raw),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
  };
  return withJoinKeysLock(() => {
    const file = readFile();
    writeFile({ schema_version: 1, keys: [...prune(file.keys, now), record] });
    return { id: record.id, key: raw, expires_at: record.expires_at };
  });
}

export type JoinKeyRejection =
  | 'invalid'
  | 'expired'
  | 'already_used'
  | 'revoked'
  /** The key was GOOD; a caller-supplied precondition refused. Distinct from
   *  every other reason because the key is left unspent — and because the
   *  caller may answer it differently, having proven it holds a real key. */
  | 'precondition';

export type JoinKeyCheck =
  | { ok: true; id: string }
  | { ok: false; reason: JoinKeyRejection };

/**
 * Validate a presented key and CONSUME it in the same pass.
 *
 * Validation and consumption are deliberately one operation. Splitting them
 * leaves a window in which two enrollments both validate the same key before
 * either marks it spent, which is exactly what "single use" is supposed to
 * prevent — and the window is widest under the condition that matters (two
 * members handed the same key, joining at once).
 *
 * Comparison is constant-time over fixed-length digests. The scan is over every
 * candidate rather than short-circuiting on the first match, so the time taken
 * does not reveal *which* key matched or how many exist.
 *
 * `precondition` runs only once the key is PROVEN GOOD, and its failure leaves
 * the key unspent. That ordering is the point: a condition checked before the
 * key would answer callers who hold no key at all, turning whatever it inspects
 * into an oracle anyone reaching the public URL can read. Checked here, the
 * answer costs a valid unspent key to obtain. It must not take a lock of its
 * own — this runs inside one.
 */
export function consumeJoinKey(
  presented: string,
  opts: { machineId?: string; now?: () => number; precondition?: () => boolean } = {},
): JoinKeyCheck {
  const now = opts.now?.() ?? Date.now();
  return withJoinKeysLock((): JoinKeyCheck => {
  const file = readFile();
  const presentedDigest = crypto.createHash('sha256').update(presented, 'utf-8').digest();

  let matched: JoinKeyRecord | null = null;
  for (const key of file.keys) {
    let expectedDigest: Buffer;
    try {
      expectedDigest = Buffer.from(key.hash, 'hex');
    } catch {
      continue;
    }
    if (expectedDigest.length !== presentedDigest.length) continue;
    if (crypto.timingSafeEqual(presentedDigest, expectedDigest)) matched = key;
  }

  if (!matched) return { ok: false, reason: 'invalid' };
  if (matched.revoked_at) return { ok: false, reason: 'revoked' };
  if (matched.used_at) return { ok: false, reason: 'already_used' };
  if (Date.parse(matched.expires_at) <= now) return { ok: false, reason: 'expired' };

  // The key is good. Only now may a precondition see anything — and refusing
  // here leaves it unspent, so a caller turned away for a reason that is not
  // their fault keeps their invite.
  if (opts.precondition && !opts.precondition()) return { ok: false, reason: 'precondition' };

  const consumed: JoinKeyRecord = {
    ...matched,
    used_at: new Date(now).toISOString(),
    ...(opts.machineId ? { used_by: opts.machineId } : {}),
  };
  writeFile({
    schema_version: 1,
    keys: prune(file.keys.map((k) => (k.id === matched!.id ? consumed : k)), now),
  });
  return { ok: true, id: matched.id };
  });
}

export interface JoinKeySummary {
  id: string;
  created_at: string;
  expires_at: string;
  state: 'active' | 'used' | 'expired' | 'revoked';
  used_by?: string;
}

/** Operator view. Never exposes a hash, let alone a key. */
export function listJoinKeys(opts: { now?: () => number } = {}): JoinKeySummary[] {
  const now = opts.now?.() ?? Date.now();
  return readFile().keys.map((k) => ({
    id: k.id,
    created_at: k.created_at,
    expires_at: k.expires_at,
    state: k.revoked_at ? 'revoked'
      : k.used_at ? 'used'
        : Date.parse(k.expires_at) <= now ? 'expired'
          : 'active',
    ...(k.used_by ? { used_by: k.used_by } : {}),
  }));
}

/** Revoke an unused key by id. Returns false when the id is unknown; revoking
 *  an already-settled key is a no-op that still reports true, so a double-click
 *  is not an error. */
export function revokeJoinKey(id: string, opts: { now?: () => number } = {}): boolean {
  const now = opts.now?.() ?? Date.now();
  return withJoinKeysLock(() => {
    const file = readFile();
    const target = file.keys.find((k) => k.id === id);
    if (!target) return false;
    if (target.used_at || target.revoked_at) return true;
    writeFile({
      schema_version: 1,
      keys: file.keys.map((k) => (k.id === id ? { ...k, revoked_at: new Date(now).toISOString() } : k)),
    });
    return true;
  });
}
