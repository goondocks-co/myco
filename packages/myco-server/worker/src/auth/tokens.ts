import type { D1Like } from '../env.js';
import { SERVER_SCHEMA_VERSION } from '../constants.js';
import { sha256Hex } from '../hash.js';
import { SchemaMismatchError } from '../telemetry.js';

export const MEMBER_TOKEN_BYTES = 32;
export const MEMBER_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Shape of every minted token: 32 random bytes as unpadded base64url. The same wire shape is minted by `packages/myco/src/team-host/member-tokens.ts` for the 1.x team host; the two modules share no code. */
export const MEMBER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface MemberAuth {
  projectId: string;
  tokenId: string;
  machineId: string | null;
  bytesWritten: number;
}

export interface IssuedMemberToken {
  token: string;
  tokenId: string;
  expiresAt: number;
}

interface MemberTokenRow {
  id: string;
  project_id: string;
  machine_id: string | null;
  expires_at: number;
  revoked_at: number | null;
  bytes_written: number;
  schema_version: string | null;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function mintMemberToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(MEMBER_TOKEN_BYTES)));
}

/** Sole inserter of member_tokens rows. Stores the digest; returns the raw token once. */
export async function issueMemberToken(
  db: D1Like, member: { projectId: string; machineId: string | null }, nowMs: number,
): Promise<IssuedMemberToken> {
  const token = mintMemberToken();
  const tokenId = `mt_${base64url(crypto.getRandomValues(new Uint8Array(12)))}`;
  const expiresAt = nowMs + MEMBER_TOKEN_TTL_MS;
  await db
    .prepare(`INSERT INTO member_tokens (id, project_id, machine_id, token_hash, expires_at, revoked_at, bytes_written)
              VALUES (?, ?, ?, ?, ?, NULL, 0)`)
    .bind(tokenId, member.projectId, member.machineId, await sha256Hex(token), expiresAt)
    .run();
  return { token, tokenId, expiresAt };
}

/** Marks a token revoked; a revoked token never authenticates again. `revoked` is false when no live row matched the id. */
export async function revokeMemberToken(db: D1Like, tokenId: string, nowMs: number): Promise<{ revoked: boolean }> {
  const result = await db
    .prepare(`UPDATE member_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(nowMs, tokenId)
    .run();
  return { revoked: result.meta.changes === 1 };
}

/** Resolves a token digest to its live member row; the same read carries the database schema version, which must equal this build's. */
export async function authenticateServerMemberToken(
  db: D1Like, digest: string, nowMs: number,
): Promise<MemberAuth | null> {
  const row = await db
    .prepare(`SELECT id, project_id, machine_id, expires_at, revoked_at, bytes_written,
                     (SELECT value FROM schema_meta WHERE key = 'version') AS schema_version
                FROM member_tokens WHERE token_hash = ?`)
    .bind(digest)
    .first<MemberTokenRow>();

  if (!row) return null;
  if (row.schema_version !== String(SERVER_SCHEMA_VERSION)) throw new SchemaMismatchError(SERVER_SCHEMA_VERSION, row.schema_version);
  if (row.revoked_at !== null) return null;
  if (row.expires_at <= nowMs) return null;
  return { projectId: row.project_id, tokenId: row.id, machineId: row.machine_id, bytesWritten: row.bytes_written };
}
