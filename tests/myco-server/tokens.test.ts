import { describe, it, expect } from 'bun:test';
import {
  MEMBER_TOKEN_BYTES, MEMBER_TOKEN_TTL_MS, MEMBER_TOKEN_PATTERN, MEMBER_TOKEN_REFRESH_WINDOW_MS, MEMBER_TOKEN_MAX_LINEAGE_MS,
  mintMemberToken, issueMemberToken, revokeMemberToken, revokeMemberLineage, authenticateServerMemberToken,
} from '@myco-server-worker/auth/tokens.js';
import { MEMBER_TOKEN_BYTE_QUOTA, TOKEN_ID_PREFIX } from '@myco-server-worker/constants.js';
import { SchemaMismatchError } from '@myco-server-worker/telemetry.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { authRow, noMemberRow } from './helpers/rows.js';

const fakeDb = (row: Record<string, unknown> | null) =>
  ({ prepare: () => ({ bind: () => ({ first: async () => row, run: async () => ({ results: [], meta: { changes: 1 } }) }) }) }) as any;

function recordingDb(changes = 1) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = { prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({ run: async () => { calls.push({ sql, params }); return { results: [], meta: { changes } }; }, first: async () => null }) }) } as any;
  return { db, calls };
}

describe('member tokens', () => {
  it('mints at the entropy floor with a url-safe charset matching the admission pattern', () => {
    expect(MEMBER_TOKEN_BYTES).toBeGreaterThanOrEqual(32);
    expect(mintMemberToken()).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(mintMemberToken()).not.toBe(mintMemberToken());
    for (let i = 0; i < 50; i++) expect(mintMemberToken()).toMatch(MEMBER_TOKEN_PATTERN);
    expect(`${mintMemberToken()}x`).not.toMatch(MEMBER_TOKEN_PATTERN);
    expect(mintMemberToken().length).toBe(Math.ceil((MEMBER_TOKEN_BYTES * 4) / 3));
  });

  it('bounds the credential lifetime, the refresh window, the lineage, and the write volume', () => {
    expect(MEMBER_TOKEN_TTL_MS).toBeGreaterThan(0);
    expect(MEMBER_TOKEN_TTL_MS).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
    expect(MEMBER_TOKEN_REFRESH_WINDOW_MS).toBe(MEMBER_TOKEN_TTL_MS / 4);
    expect(MEMBER_TOKEN_MAX_LINEAGE_MS).toBe(90 * 24 * 60 * 60 * 1000);
    expect(MEMBER_TOKEN_MAX_LINEAGE_MS).toBeGreaterThan(MEMBER_TOKEN_TTL_MS);
    expect(MEMBER_TOKEN_BYTE_QUOTA).toBeGreaterThan(0);
  });

  it('issues a root token whose row expires exactly one TTL after issue, roots its own lineage at issue, always lands, and stores only the digest', async () => {
    const { db, calls } = recordingDb();
    const issued = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, 5_000);
    expect(issued.expiresAt - 5_000).toBe(MEMBER_TOKEN_TTL_MS);
    expect(issued.tokenId.startsWith(TOKEN_ID_PREFIX)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/INSERT INTO member_credentials \(id, member_id, machine_id, token_hash, issued_at, expires_at, revoked_at, bytes_written, predecessor_id, lineage_root, lineage_started_at, first_used_at\)/);
    expect(calls[0].sql).toMatch(/SELECT \?, \?, \?, \?, \?, \?, NULL, 0, \?, \?, \?, NULL\s+WHERE \? IS NULL OR EXISTS \(SELECT 1 FROM member_credentials WHERE id = \? AND revoked_at IS NULL\)/);
    expect(calls[0].params).toEqual([issued.tokenId, 'mem_machine_1', 'machine_1', await sha256Hex(issued.token), 5_000, issued.expiresAt, null, issued.tokenId, 5_000, null, null]);
    expect(calls[0].params).not.toContain(issued.token);
  });

  it('issues a successor into its predecessor\'s lineage, only while the predecessor is live, expiring one TTL from now or at the lineage ceiling, whichever is sooner', async () => {
    const { db, calls } = recordingDb();
    const inside = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, 5_000, { predecessorId: 'mt_pred', lineageRoot: 'mt_root', lineageStartedAt: 1_000 });
    expect(inside.expiresAt).toBe(5_000 + MEMBER_TOKEN_TTL_MS);
    expect(calls[0].params).toEqual([inside.tokenId, 'mem_machine_1', 'machine_1', await sha256Hex(inside.token), 5_000, inside.expiresAt, 'mt_pred', 'mt_root', 1_000, 'mt_pred', 'mt_pred']);
    const startedAt = 5_000 - MEMBER_TOKEN_MAX_LINEAGE_MS + 10;
    const clamped = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, 5_000, { predecessorId: 'mt_pred', lineageRoot: 'mt_root', lineageStartedAt: startedAt });
    expect(clamped.expiresAt).toBe(startedAt + MEMBER_TOKEN_MAX_LINEAGE_MS);
    expect(clamped.expiresAt).toBe(5_010);
  });

  it('revokes a whole lineage by any of its ids in one statement, counting the rows that changed', async () => {
    const { db, calls } = recordingDb(3);
    expect(await revokeMemberLineage(db, 'mt_mid', 9_000)).toEqual({ revoked: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/UPDATE member_credentials SET revoked_at = \? WHERE lineage_root = \(SELECT lineage_root FROM member_credentials WHERE id = \?\) AND revoked_at IS NULL/);
    expect(calls[0].params).toEqual([9_000, 'mt_mid']);
    expect(await revokeMemberLineage(recordingDb(0).db, 'mt_missing', 9_000)).toEqual({ revoked: 0 });
  });

  it('revokes by id and only once, reporting whether a live row matched', async () => {
    const { db, calls } = recordingDb();
    expect(await revokeMemberToken(db, 'mt_1', 9_000)).toEqual({ revoked: true });
    expect(calls[0].sql).toMatch(/UPDATE member_credentials SET revoked_at = \? WHERE id = \? AND revoked_at IS NULL/);
    expect(calls[0].params).toEqual([9_000, 'mt_1']);
    expect(await revokeMemberToken(recordingDb(0).db, 'mt_missing', 9_000)).toEqual({ revoked: false });
  });

  it('authenticates a live token digest and returns its bound machine, volume, lifetime, lineage, predecessor and first use', async () => {
    const digest = await sha256Hex(mintMemberToken());
    expect(await authenticateServerMemberToken(fakeDb(authRow({ bytes_written: 42 })), digest, 1_000))
      .toEqual({ memberId: 'mem_1', tokenId: 'mt_1', machineId: 'machine_1', bytesWritten: 42, expiresAt: 2_000, lineageRoot: 'mt_1', lineageStartedAt: 1_000, predecessorId: null, firstUsedAt: null });
    expect(await authenticateServerMemberToken(fakeDb(authRow({ predecessor_id: 'mt_0', lineage_root: 'mt_0', lineage_started_at: 500, first_used_at: 900 })), digest, 1_000))
      .toMatchObject({ predecessorId: 'mt_0', lineageRoot: 'mt_0', lineageStartedAt: 500, firstUsedAt: 900 });
  });

  it('rejects expired, revoked, unknown, and lineage-less tokens', async () => {
    const digest = await sha256Hex(mintMemberToken());
    expect(await authenticateServerMemberToken(fakeDb(authRow({ expires_at: 500 })), digest, 1_000)).toBeNull();
    expect(await authenticateServerMemberToken(fakeDb(authRow({ revoked_at: 900 })), digest, 1_000)).toBeNull();
    expect(await authenticateServerMemberToken(fakeDb(noMemberRow()), digest, 1_000)).toBeNull();
    expect(await authenticateServerMemberToken(fakeDb(authRow({ lineage_root: null })), digest, 1_000)).toBeNull();
    expect(await authenticateServerMemberToken(fakeDb(authRow({ lineage_started_at: null })), digest, 1_000)).toBeNull();
  });

  it('refuses to authenticate against a database at another schema version, whether or not the token exists', async () => {
    const digest = await sha256Hex(mintMemberToken());
    await expect(authenticateServerMemberToken(fakeDb(authRow({ schema_version: '0' })), digest, 1_000)).rejects.toBeInstanceOf(SchemaMismatchError);
    await expect(authenticateServerMemberToken(fakeDb(noMemberRow({ schema_version: '0' })), digest, 1_000)).rejects.toBeInstanceOf(SchemaMismatchError);
    await expect(authenticateServerMemberToken(fakeDb(null), digest, 1_000)).rejects.toBeInstanceOf(SchemaMismatchError);
  });
});
