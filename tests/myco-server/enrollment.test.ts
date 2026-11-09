/**
 * Enrollment authorities: the invitation a join exchanges for a credential.
 *
 * The single-use property is a concurrency correctness problem, not a policy
 * flag — a read-then-mark-used spend admits two joins on one key under a race.
 * These assert the properties, not the implementation.
 */
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { ENROLLMENT_KEY_PATTERN, issueEnrollmentAuthority, revokeEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { joinMember } from '@myco-server-worker/auth/join.js';

function store() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const s of SCHEMA_STEPS.flatMap((x) => x.statements)) sqlite.exec(s);
  return { db: sqliteRelationalStore(sqlite), sqlite };
}
const NOW = 1_700_000_000_000;

/** Exchanges a key through the one join that spends it, answering what the wire carries. */
async function joined(db: ServerEnv['db'], key: string, now: number, machineId: string): Promise<{ joined: boolean; code?: string }> {
  return await (await joinMember({ db } as ServerEnv, { key, machineId }, now)).json() as { joined: boolean; code?: string };
}

describe('enrollment authorities', () => {
  it('mints 256 bits of entropy and stores only the digest', async () => {
    const { db, sqlite } = store();
    const issued = await issueEnrollmentAuthority(db, NOW, { issuer: { kind: 'operator' }, role: 'member' });
    expect(ENROLLMENT_KEY_PATTERN.test(issued.key)).toBe(true);
    const row = sqlite.query(`SELECT key_hash FROM enrollment_authorities WHERE id = ?`).get(issued.id) as { key_hash: string };
    expect(row.key_hash).toBe(await sha256Hex(issued.key));
    // The raw key is nowhere in the row.
    const all = JSON.stringify(sqlite.query(`SELECT * FROM enrollment_authorities`).all());
    expect(all.includes(issued.key)).toBe(false);
  });

  it('spends once, and a second presentation is refused as already used', async () => {
    const { db } = store();
    const issued = await issueEnrollmentAuthority(db, NOW, { issuer: { kind: 'operator' }, role: 'member' });
    expect(await joined(db, issued.key, NOW, 'runtime_a')).toMatchObject({ joined: true });
    expect(await joined(db, issued.key, NOW, 'runtime_b')).toMatchObject({ joined: false, code: 'enrollment_used' });
  });

  it('admits exactly one winner when many runtimes redeem the same key concurrently', async () => {
    const { db } = store();
    const issued = await issueEnrollmentAuthority(db, NOW, { issuer: { kind: 'operator' }, role: 'member' });
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => joined(db, issued.key, NOW, `runtime_${i}`)));
    expect(results.filter((r) => r.joined).length).toBe(1);
    expect(results.filter((r) => !r.joined).every((r) => r.code === 'enrollment_used')).toBe(true);
  });

  it('records which runtime spent it, for operator provenance', async () => {
    const { db, sqlite } = store();
    const issued = await issueEnrollmentAuthority(db, NOW, { issuer: { kind: 'operator' }, role: 'member' });
    await joined(db, issued.key, NOW, 'laptop-1');
    const row = sqlite.query(`SELECT used_by_runtime, used_at FROM enrollment_authorities WHERE id = ?`).get(issued.id) as { used_by_runtime: string; used_at: number };
    expect({ runtime: row.used_by_runtime, usedAt: row.used_at }).toEqual({ runtime: 'laptop-1', usedAt: NOW });
  });

  it('refuses an expired key, and expiry does not mark it used', async () => {
    const { db, sqlite } = store();
    const issued = await issueEnrollmentAuthority(db, NOW, { issuer: { kind: 'operator' }, role: 'member', ttlMs: 1_000 });
    expect(await joined(db, issued.key, NOW + 2_000, 'r')).toMatchObject({ joined: false, code: 'enrollment_expired' });
    const row = sqlite.query(`SELECT used_at FROM enrollment_authorities WHERE id = ?`).get(issued.id) as { used_at: number | null };
    expect(row.used_at).toBeNull();
  });

  it('refuses a revoked key, and revoking a spent key reports no change', async () => {
    const { db } = store();
    const a = await issueEnrollmentAuthority(db, NOW, { issuer: { kind: 'operator' }, role: 'member' });
    expect(await revokeEnrollmentAuthority(db, a.id, NOW, 'mem_machine_1')).toEqual({ revoked: true });
    expect(await joined(db, a.key, NOW, 'r')).toMatchObject({ joined: false, code: 'enrollment_revoked' });

    const b = await issueEnrollmentAuthority(db, NOW, { issuer: { kind: 'operator' }, role: 'member' });
    await joined(db, b.key, NOW, 'r');
    expect(await revokeEnrollmentAuthority(db, b.id, NOW, 'mem_machine_1')).toEqual({ revoked: false });
  });

  it('refuses an unknown key, and text that is not a key at all', async () => {
    const { db } = store();
    expect(await joined(db, 'A'.repeat(43), NOW, 'r')).toMatchObject({ joined: false, code: 'enrollment_unknown' });
    expect(await joined(db, 'not-a-key', NOW, 'r')).toMatchObject({ joined: false, code: 'enrollment_unknown' });
  });
});
