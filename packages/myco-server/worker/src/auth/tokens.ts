import type { D1Like } from '../env.js';
import { SERVER_SCHEMA_VERSION, TOKEN_ID_BYTES, TOKEN_ID_PREFIX } from '../constants.js';
import { sha256Hex } from '../hash.js';
import { SchemaMismatchError } from '../telemetry.js';

export const MEMBER_TOKEN_BYTES = 32;
export const MEMBER_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Shape of every minted token: `MEMBER_TOKEN_BYTES` random bytes as unpadded base64url. */
export const MEMBER_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((MEMBER_TOKEN_BYTES * 4) / 3)}}$`);

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

interface AuthRow {
  schema_version: string;
  id: string | null;
  project_id: string | null;
  machine_id: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  bytes_written: number | null;
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
  const tokenId = `${TOKEN_ID_PREFIX}${base64url(crypto.getRandomValues(new Uint8Array(TOKEN_ID_BYTES)))}`;
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

/** One read: the database schema version, joined to the member row for the digest when one exists. The version must equal this build's before any token decision is made; a missing version row is a mismatch. */
export async function authenticateServerMemberToken(
  db: D1Like, digest: string, nowMs: number,
): Promise<MemberAuth | null> {
  const row = await db
    .prepare(`SELECT s.value AS schema_version,
                     t.id, t.project_id, t.machine_id, t.expires_at, t.revoked_at, t.bytes_written
                FROM schema_meta s
                LEFT JOIN member_tokens t ON t.token_hash = ?
               WHERE s.key = 'version'`)
    .bind(digest)
    .first<AuthRow>();

  if (!row) throw new SchemaMismatchError(SERVER_SCHEMA_VERSION, null);
  if (row.schema_version !== String(SERVER_SCHEMA_VERSION)) throw new SchemaMismatchError(SERVER_SCHEMA_VERSION, row.schema_version);
  if (row.id === null || row.project_id === null || row.expires_at === null || row.bytes_written === null) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at <= nowMs) return null;
  return { projectId: row.project_id, tokenId: row.id, machineId: row.machine_id, bytesWritten: row.bytes_written };
}
