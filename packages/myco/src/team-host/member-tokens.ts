/**
 * Per-member tokens — who a request is, and how to stop being them.
 *
 * The host used to accept ONE shared bearer, handed to every member at
 * enrollment. That has two consequences worth naming plainly, because they are
 * why this module exists rather than being an extension of the old one:
 *
 *   - **Revocation was impossible.** Every member holds the same secret, so
 *     removing one member means rotating for all of them. The one rotate
 *     function that existed had zero callers and its own docstring conceded a
 *     rotation "is inert until the daemon restarts".
 *   - **A request had no identity.** Attribution came from an unauthenticated
 *     `x-myco-machine-id` header the caller chose per request.
 *
 * A token is bound to the `machine_id` its member self-asserted at enrollment.
 * Be precise about what that buys: the host is NOT verifying machine identity,
 * it is pinning a **trust-on-first-use anchor**. What was a per-request claim
 * becomes a value fixed at join time and checked against every request after —
 * a real improvement, and the start of authenticated machine identity, not its
 * completion.
 *
 * REVOCATION IS EFFECTIVE ON THE NEXT REQUEST. The store is re-read on every
 * validation rather than cached at startup. That is the property the shared
 * bearer lacked, and caching here — however cheap it looks — silently restores
 * "revocation needs a restart", which is the thing being fixed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/lifecycle-lock.js';
import { resolveHostControlDir } from '../grove/paths.js';

/** Filename under {@link resolveHostControlDir}. */
export const MEMBER_TOKENS_FILENAME = 'members.json';

/** Bytes of entropy in a member token. 32 = 256 bits, matching the join key:
 *  this is the credential every subsequent request carries, so it is not the
 *  place to economise. */
const MEMBER_TOKEN_BYTES = 32;

/** A member as it exists on disk. The raw token is NEVER stored. */
export interface MemberRecord {
  id: string;
  /** SHA-256 of the raw token, hex. */
  token_hash: string;
  /** The machine_id asserted at enrollment — the TOFU anchor. */
  machine_id: string;
  label?: string;
  issued_at: string;
  revoked_at?: string;
  /** Operator-facing liveness. Written best-effort on successful validation. */
  last_seen_at?: string;
}

interface MemberFile {
  schema_version: 1;
  members: MemberRecord[];
}

export function memberTokensPath(): string {
  return path.join(resolveHostControlDir(), MEMBER_TOKENS_FILENAME);
}

/**
 * Serialize every read-modify-write on this file.
 *
 * Reads (the per-request validation) deliberately take no lock — they are the
 * hot path and a torn read is impossible, since writes publish atomically via
 * temp+rename. Writes DO, because they are read-modify-write over the whole
 * list and the store lives under the machine-global team home, shared by every
 * daemon on the box. A lost update here is not cosmetic: a revoke racing an
 * issue could resurrect a revoked member.
 */
function withMembersLock<T>(fn: () => T): T {
  const dir = resolveHostControlDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withFileLockSync(path.join(dir, `${MEMBER_TOKENS_FILENAME}.lock`), fn);
}

function readFile(): MemberFile {
  let raw: string;
  try {
    raw = fs.readFileSync(memberTokensPath(), 'utf-8');
  } catch {
    return { schema_version: 1, members: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MemberFile>;
    if (!Array.isArray(parsed.members)) return { schema_version: 1, members: [] };
    const members = parsed.members.filter((m): m is MemberRecord =>
      Boolean(m) && typeof m === 'object'
      && typeof (m as MemberRecord).id === 'string'
      && typeof (m as MemberRecord).token_hash === 'string'
      && typeof (m as MemberRecord).machine_id === 'string');
    return { schema_version: 1, members };
  } catch {
    // A corrupt file must not authenticate anyone. Empty means every request
    // 401s, which is the fail-closed direction.
    return { schema_version: 1, members: [] };
  }
}

function writeFile(file: MemberFile): void {
  const dir = resolveHostControlDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(memberTokensPath(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, durable: true });
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf-8').digest('hex');
}

export interface IssuedMemberToken {
  id: string;
  /** The RAW token. Returned once, at enrollment. Never stored, never logged. */
  token: string;
  machineId: string;
}

/**
 * Upper bound on a stored `machine_id`. Real ones are `{user}_{8-hex}`; this
 * is generous room for a long username, not a guess at the format. It exists
 * because the value is self-asserted at enrollment and then lands in the
 * operator's roster and the action log.
 */
export const MAX_MACHINE_ID_LENGTH = 128;

/** Thrown when a machine that ALREADY holds a live token enrolls again. */
export class MemberAlreadyEnrolledError extends Error {
  readonly code = 'machine_already_enrolled';
  constructor(machineId: string) {
    super(`Machine ${machineId} already has access.`);
    this.name = 'MemberAlreadyEnrolledError';
  }
}

/**
 * Issue a token for a member, bound to the machine_id it asserted.
 *
 * REFUSES if that machine already holds a LIVE token. `machine_id` at
 * enrollment is self-asserted wire data, and this function replaces any record
 * matching it — so silently replacing would let any member holding a valid join
 * key evict any other member by asserting their id, locking them out while the
 * operator's roster just shows one row where there were two. Revocation is the
 * operator's lever; refusing here is what keeps it theirs.
 *
 * A REVOKED record does not block re-joining — that is the intended path back
 * in, and replacing it keeps one row per machine. Two live tokens for one
 * machine would mean revoking the row an operator can see leaves an older
 * credential working.
 *
 * The check and the write share one lock: split apart, two concurrent
 * enrollments for the same machine would both pass the check and the second
 * would still evict the first.
 */
export function issueMemberToken(
  machineId: string,
  opts: { label?: string; now?: () => number } = {},
): IssuedMemberToken {
  const now = opts.now?.() ?? Date.now();
  const raw = crypto.randomBytes(MEMBER_TOKEN_BYTES).toString('base64url');
  const record: MemberRecord = {
    id: crypto.randomUUID(),
    token_hash: hashToken(raw),
    machine_id: machineId,
    ...(opts.label ? { label: opts.label } : {}),
    issued_at: new Date(now).toISOString(),
  };
  return withMembersLock(() => {
    const file = readFile();
    if (file.members.some((m) => m.machine_id === machineId && !m.revoked_at)) {
      throw new MemberAlreadyEnrolledError(machineId);
    }
    writeFile({
      schema_version: 1,
      members: [...file.members.filter((m) => m.machine_id !== machineId), record],
    });
    return { id: record.id, token: raw, machineId };
  });
}

export type MemberAuth =
  | { ok: true; id: string; machineId: string }
  | { ok: false };

/**
 * Validate a presented token, re-reading the store EVERY time.
 *
 * The re-read is the revocation guarantee, not an oversight — see the module
 * docstring. The scan visits every member rather than short-circuiting, so the
 * time taken does not leak which member matched or how many exist.
 */
export function authenticateMemberToken(presented: string): MemberAuth {
  const presentedDigest = crypto.createHash('sha256').update(presented, 'utf-8').digest();
  let matched: MemberRecord | null = null;
  for (const member of readFile().members) {
    let expectedDigest: Buffer;
    try {
      expectedDigest = Buffer.from(member.token_hash, 'hex');
    } catch {
      continue;
    }
    if (expectedDigest.length !== presentedDigest.length) continue;
    if (crypto.timingSafeEqual(presentedDigest, expectedDigest)) matched = member;
  }
  if (!matched || matched.revoked_at) return { ok: false };
  return { ok: true, id: matched.id, machineId: matched.machine_id };
}

export interface MemberSummary {
  id: string;
  machine_id: string;
  label?: string;
  issued_at: string;
  last_seen_at?: string;
  revoked: boolean;
}

/**
 * Does this machine already hold a LIVE token?
 *
 * A cheap pre-check so the enrollment route can refuse a collision WITHOUT
 * spending the caller's single-use key. Advisory only — it can race, so the
 * authoritative refusal stays inside {@link issueMemberToken}'s lock.
 */
export function hasLiveMember(machineId: string): boolean {
  return readFile().members.some((m) => m.machine_id === machineId && !m.revoked_at);
}

/**
 * Give up this machine's OWN access, identified by the token it presents.
 *
 * The counterpart to `myco leave`: without it, leaving is a member-side write
 * only, the host keeps a live record forever, and re-joining hits the
 * already-enrolled refusal with no self-service way out. Revoking by the
 * AUTHENTICATED member's id is safe by construction — a caller can only ever
 * surrender the credential it already holds.
 */
export function resignMember(id: string, opts: { now?: () => number } = {}): boolean {
  return revokeMember(id, opts);
}

/** Operator view. Never exposes a hash, let alone a token. */
export function listMembers(): MemberSummary[] {
  return readFile().members.map((m) => ({
    id: m.id,
    machine_id: m.machine_id,
    ...(m.label ? { label: m.label } : {}),
    issued_at: m.issued_at,
    ...(m.last_seen_at ? { last_seen_at: m.last_seen_at } : {}),
    revoked: Boolean(m.revoked_at),
  }));
}

/** Revoke a member by id. Effective on that member's NEXT request — there is
 *  no cache to invalidate and no restart to wait for. Returns false for an
 *  unknown id; re-revoking is a no-op that reports true. */
export function revokeMember(id: string, opts: { now?: () => number } = {}): boolean {
  const now = opts.now?.() ?? Date.now();
  return withMembersLock(() => {
    const file = readFile();
    const target = file.members.find((m) => m.id === id);
    if (!target) return false;
    if (target.revoked_at) return true;
    writeFile({
      schema_version: 1,
      members: file.members.map((m) => (m.id === id ? { ...m, revoked_at: new Date(now).toISOString() } : m)),
    });
    return true;
  });
}

/** How stale `last_seen_at` may get before a request refreshes it. */
export const MEMBER_SEEN_COALESCE_MS = 60_000;

/**
 * Record liveness for the operator view.
 *
 * Called on EVERY authenticated request, so it coalesces: a write rewrites the
 * whole roster under the same lock every gate path takes, and doing that per
 * request would put a serialized file write on the hot path to save a field
 * nothing reads more precisely than "recently". Within the window this is a
 * read and nothing more.
 *
 * Best-effort by construction — a failure here must never fail an
 * authenticated request.
 */
export function noteMemberSeen(id: string, opts: { now?: () => number } = {}): void {
  try {
    const now = opts.now?.() ?? Date.now();
    const existing = readFile().members.find((m) => m.id === id);
    if (!existing) return;
    if (existing.last_seen_at && now - Date.parse(existing.last_seen_at) < MEMBER_SEEN_COALESCE_MS) return;
    withMembersLock(() => {
      const file = readFile();
      if (!file.members.some((m) => m.id === id)) return;
      writeFile({
        schema_version: 1,
        members: file.members.map((m) => (m.id === id ? { ...m, last_seen_at: new Date(now).toISOString() } : m)),
      });
    });
  } catch { /* liveness is cosmetic */ }
}
