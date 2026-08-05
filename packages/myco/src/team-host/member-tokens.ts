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
 * Issue a token for a member, bound to the machine_id it asserted.
 *
 * A RE-JOIN from the same machine_id REPLACES that member's token rather than
 * adding a second one. Two live tokens for one machine would mean revoking a
 * member does not actually remove them — the operator revokes the row they can
 * see and the older credential keeps working.
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

/** Record liveness for the operator view. Best-effort and never on the
 *  critical path: a failure here must not fail an authenticated request. */
export function noteMemberSeen(id: string, opts: { now?: () => number } = {}): void {
  try {
    const now = opts.now?.() ?? Date.now();
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
