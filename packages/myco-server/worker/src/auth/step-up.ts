import type { RelationalStore } from '../core/adapters.js';
import { sha256Hex } from '../hash.js';

/**
 * Step-up authority — proof beyond membership, for the operations #907 puts
 * outside the flat model.
 *
 * Membership is flat: every member manages Deployment Settings, enrolls runtimes,
 * and manages grants. Four operations are not flat, and each is destructive or
 * secret-bearing. This is what a member presents to perform one.
 *
 * The mechanism is the enrollment authority's, generalised rather than reinvented
 * — 256 bits, hashed at rest, spent by one conditional update, expiring, and
 * revocable. That is deliberate: it is the third use of a shape this codebase has
 * already proven twice, and a second bespoke credential lifecycle would be a
 * second set of the same mistakes.
 *
 * Minting is a break-glass operation. Whoever controls the Deployment's store can
 * mint one directly, which is the same authority #907 settled as the recovery
 * path, and it keeps the sensitive operations reachable without inventing a
 * privileged role the flat model exists to remove.
 */

/** Bytes of entropy in a step-up key. 32 = 256 bits. */
export const STEP_UP_KEY_BYTES = 32;

/**
 * Lifetime of a freshly minted authority.
 *
 * Far shorter than an enrollment authority's hour. An enrollment key is handed to
 * someone who may act later; a step-up key is presented by someone already at the
 * keyboard, so anything longer is a standing privilege sitting in a chat log.
 */
export const STEP_UP_TTL_MS = 10 * 60 * 1000;

export const STEP_UP_ID_PREFIX = 'su_';
const STEP_UP_ID_BYTES = 12;

/** Shape of every minted key: `STEP_UP_KEY_BYTES` random bytes as unpadded base64url. */
export const STEP_UP_KEY_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((STEP_UP_KEY_BYTES * 4) / 3)}}$`);

/**
 * The operation classes an authority may be minted for — #907's four, verbatim.
 *
 * An authority carries exactly one. Spending is checked against the purpose the
 * caller is acting under, so an authority minted to rotate a credential cannot
 * destroy a Deployment.
 */
export const STEP_UP_PURPOSES = [
  'provider_credential',
  'deployment_lifecycle',
  'enrollment_root_rotation',
  'project_reassignment',
] as const;
export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number];

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface IssuedStepUpAuthority {
  key: string;
  id: string;
  expiresAt: number;
}

/** Sole minter. Stores the digest; returns the raw key once. */
export async function issueStepUpAuthority(
  db: RelationalStore, purpose: StepUpPurpose, nowMs: number, options: { ttlMs?: number } = {},
): Promise<IssuedStepUpAuthority> {
  const key = base64url(crypto.getRandomValues(new Uint8Array(STEP_UP_KEY_BYTES)));
  const id = `${STEP_UP_ID_PREFIX}${base64url(crypto.getRandomValues(new Uint8Array(STEP_UP_ID_BYTES)))}`;
  const expiresAt = nowMs + (options.ttlMs ?? STEP_UP_TTL_MS);
  await db
    .prepare(`INSERT INTO step_up_authorities (id, key_hash, purpose, created_at, expires_at, used_at, used_by, revoked_at)
              VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`)
    .bind(id, await sha256Hex(key), purpose, nowMs, expiresAt)
    .run();
  return { key, id, expiresAt };
}

/** Why a presented authority could not be spent. */
export type StepUpRefusal = 'unknown' | 'already_used' | 'expired' | 'revoked' | 'wrong_purpose';

export type StepUpResult = { ok: true; id: string } | { ok: false; reason: StepUpRefusal };

/**
 * Spends a presented key for `purpose`, once.
 *
 * One conditional update carries every condition — unused, unrevoked, unexpired,
 * and minted for this purpose — and success is decided by whether it changed a
 * row. Two members presenting one key produce one winner. The read afterwards
 * only explains a refusal and never decides the outcome.
 */
export async function spendStepUpAuthority(
  db: RelationalStore, presentedKey: string, purpose: StepUpPurpose, memberId: string, nowMs: number,
): Promise<StepUpResult> {
  if (!STEP_UP_KEY_PATTERN.test(presentedKey)) return { ok: false, reason: 'unknown' };
  const keyHash = await sha256Hex(presentedKey);

  const spend = await db
    .prepare(`UPDATE step_up_authorities SET used_at = ?, used_by = ?
               WHERE key_hash = ? AND purpose = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
    .bind(nowMs, memberId, keyHash, purpose, nowMs)
    .run();

  const row = await db
    .prepare(`SELECT id, purpose, used_at, revoked_at, expires_at FROM step_up_authorities WHERE key_hash = ?`)
    .bind(keyHash)
    .first<{ id: string; purpose: string; used_at: number | null; revoked_at: number | null; expires_at: number }>();

  if (spend.meta.changes === 1) return { ok: true, id: row!.id };
  if (row === null) return { ok: false, reason: 'unknown' };
  if (row.purpose !== purpose) return { ok: false, reason: 'wrong_purpose' };
  if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };
  if (row.used_at !== null) return { ok: false, reason: 'already_used' };
  return { ok: false, reason: 'expired' };
}

/** Revokes an unused authority. `revoked` is false when no unused row matched. */
export async function revokeStepUpAuthority(db: RelationalStore, id: string, nowMs: number): Promise<{ revoked: boolean }> {
  const result = await db
    .prepare(`UPDATE step_up_authorities SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND used_at IS NULL`)
    .bind(nowMs, id)
    .run();
  return { revoked: result.meta.changes === 1 };
}

/**
 * A settings authorizer that admits ordinary changes on membership alone and
 * requires a spent step-up authority for the leaves that decide where a
 * credential is sent.
 *
 * The authority is spent as part of authorizing, not before it: a key consumed by
 * a change that then fails validation would be gone with nothing to show, and a
 * key checked but not consumed would be replayable for the whole of its TTL.
 */
export function stepUpAuthorizer(
  db: RelationalStore,
  requiresStepUp: (leaf: string) => boolean,
  presentedKey: () => string | null,
  nowMs: () => number,
): (change: { leaf: string; actor: string }) => Promise<boolean> {
  return async ({ leaf, actor }) => {
    if (!requiresStepUp(leaf)) return true;
    const key = presentedKey();
    if (key === null) return false;
    const spent = await spendStepUpAuthority(db, key, 'provider_credential', actor, nowMs());
    return spent.ok;
  };
}
