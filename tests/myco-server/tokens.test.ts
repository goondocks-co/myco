import { describe, it, expect } from 'bun:test';
import {
  MEMBER_TOKEN_BYTES, MEMBER_TOKEN_TTL_MS, MEMBER_TOKEN_PATTERN,
  mintMemberToken, issueMemberToken, revokeMemberToken, authenticateServerMemberToken,
} from '../../packages/myco-server/worker/src/auth/tokens.js';
import { MEMBER_TOKEN_BYTE_QUOTA, SERVER_SCHEMA_VERSION } from '../../packages/myco-server/worker/src/constants.js';
import { SchemaMismatchError } from '../../packages/myco-server/worker/src/telemetry.js';
import { sha256Hex } from '../../packages/myco-server/worker/src/hash.js';

const fakeDb = (row: Record<string, unknown> | null) =>
  ({ prepare: () => ({ bind: () => ({ first: async () => row, run: async () => ({ meta: { changes: 1 } }) }) }) }) as any;

function recordingDb(changes = 1) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = { prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({ run: async () => { calls.push({ sql, params }); return { meta: { changes } }; }, first: async () => null }) }) } as any;
  return { db, calls };
}
const live = { schema_version: String(SERVER_SCHEMA_VERSION) };

describe('member tokens', () => {
  it('mints at the entropy floor with a url-safe charset', () => {
    expect(MEMBER_TOKEN_BYTES).toBeGreaterThanOrEqual(32);
    expect(mintMemberToken()).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(mintMemberToken()).not.toBe(mintMemberToken());
    for (let i = 0; i < 50; i++) expect(mintMemberToken()).toMatch(MEMBER_TOKEN_PATTERN);
    expect(`${mintMemberToken()}x`).not.toMatch(MEMBER_TOKEN_PATTERN);
  });

  it('bounds the credential lifetime and write volume', () => {
    expect(MEMBER_TOKEN_TTL_MS).toBeGreaterThan(0);
    expect(MEMBER_TOKEN_TTL_MS).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
    expect(MEMBER_TOKEN_BYTE_QUOTA).toBeGreaterThan(0);
  });

  it('issues a token whose row expires exactly one TTL after issue and stores only the digest', async () => {
    const { db, calls } = recordingDb();
    const issued = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, 5_000);
    expect(issued.expiresAt - 5_000).toBe(MEMBER_TOKEN_TTL_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/INSERT INTO member_tokens/);
    expect(calls[0].params).toEqual([issued.tokenId, 'proj_1', 'machine_1', await sha256Hex(issued.token), issued.expiresAt]);
    expect(calls[0].params).not.toContain(issued.token);
  });

  it('revokes by id and only once, reporting whether a live row matched', async () => {
    const { db, calls } = recordingDb();
    expect(await revokeMemberToken(db, 'mt_1', 9_000)).toEqual({ revoked: true });
    expect(calls[0].sql).toMatch(/UPDATE member_tokens SET revoked_at = \? WHERE id = \? AND revoked_at IS NULL/);
    expect(calls[0].params).toEqual([9_000, 'mt_1']);
    expect(await revokeMemberToken(recordingDb(0).db, 'mt_missing', 9_000)).toEqual({ revoked: false });
  });

  it('authenticates a live token digest and returns its bound machine and volume', async () => {
    const token = mintMemberToken();
    const db = fakeDb({
      id: 'mt_1', project_id: 'proj_1', machine_id: 'machine_1',
      expires_at: 2_000, revoked_at: null, bytes_written: 42, ...live,
    });
    expect(await authenticateServerMemberToken(db, await sha256Hex(token), 1_000))
      .toEqual({ projectId: 'proj_1', tokenId: 'mt_1', machineId: 'machine_1', bytesWritten: 42 });
  });

  it('rejects expired, revoked, and unknown tokens', async () => {
    const token = mintMemberToken();
    const digest = await sha256Hex(token);
    const base = { id: 'mt_1', project_id: 'p', machine_id: null, bytes_written: 0, ...live };
    expect(await authenticateServerMemberToken(fakeDb({ ...base, expires_at: 500, revoked_at: null }), digest, 1_000)).toBeNull();
    expect(await authenticateServerMemberToken(fakeDb({ ...base, expires_at: 2_000, revoked_at: 900 }), digest, 1_000)).toBeNull();
    expect(await authenticateServerMemberToken(fakeDb(null), digest, 1_000)).toBeNull();
  });

  it('refuses to authenticate against a database at another schema version', async () => {
    const digest = await sha256Hex(mintMemberToken());
    const base = { id: 'mt_1', project_id: 'p', machine_id: null, bytes_written: 0, expires_at: 2_000, revoked_at: null };
    await expect(authenticateServerMemberToken(fakeDb({ ...base, schema_version: '0' }), digest, 1_000)).rejects.toBeInstanceOf(SchemaMismatchError);
    await expect(authenticateServerMemberToken(fakeDb({ ...base, schema_version: null }), digest, 1_000)).rejects.toBeInstanceOf(SchemaMismatchError);
  });
});
