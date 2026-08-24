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
import {
  ENROLLMENT_KEY_PATTERN, issueEnrollmentAuthority, revokeEnrollmentAuthority, spendEnrollmentAuthority,
} from '@myco-server-worker/auth/enrollment.js';

function store() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const s of SCHEMA_STEPS.flatMap((x) => x.statements)) sqlite.exec(s);
  return { db: sqliteRelationalStore(sqlite), sqlite };
}
const NOW = 1_700_000_000_000;

describe('enrollment authorities', () => {
  it('mints 256 bits of entropy and stores only the digest', async () => {
    const { db, sqlite } = store();
    const issued = await issueEnrollmentAuthority(db, NOW);
    expect(ENROLLMENT_KEY_PATTERN.test(issued.key)).toBe(true);
    const row = sqlite.query(`SELECT key_hash FROM enrollment_authorities WHERE id = ?`).get(issued.id) as { key_hash: string };
    expect(row.key_hash).toBe(await sha256Hex(issued.key));
    // The raw key is nowhere in the row.
    const all = JSON.stringify(sqlite.query(`SELECT * FROM enrollment_authorities`).all());
    expect(all.includes(issued.key)).toBe(false);
  });

  it('spends once, and a second presentation is refused as already used', async () => {
    const { db } = store();
    const issued = await issueEnrollmentAuthority(db, NOW);
    expect(await spendEnrollmentAuthority(db, issued.key, NOW, 'runtime_a')).toEqual({ ok: true, id: issued.id, memberId: null });
    expect(await spendEnrollmentAuthority(db, issued.key, NOW, 'runtime_b')).toEqual({ ok: false, reason: 'already_used' });
  });

  it('admits exactly one winner when many runtimes redeem the same key concurrently', async () => {
    const { db } = store();
    const issued = await issueEnrollmentAuthority(db, NOW);
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => spendEnrollmentAuthority(db, issued.key, NOW, `runtime_${i}`)),
    );
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'already_used')).toBe(true);
  });

  it('records which runtime spent it, for operator provenance', async () => {
    const { db, sqlite } = store();
    const issued = await issueEnrollmentAuthority(db, NOW);
    await spendEnrollmentAuthority(db, issued.key, NOW, 'laptop-1');
    const row = sqlite.query(`SELECT used_by_runtime, used_at FROM enrollment_authorities WHERE id = ?`).get(issued.id) as { used_by_runtime: string; used_at: number };
    expect({ runtime: row.used_by_runtime, usedAt: row.used_at }).toEqual({ runtime: 'laptop-1', usedAt: NOW });
  });

  it('refuses an expired key, and expiry does not mark it used', async () => {
    const { db, sqlite } = store();
    const issued = await issueEnrollmentAuthority(db, NOW, { ttlMs: 1_000 });
    expect(await spendEnrollmentAuthority(db, issued.key, NOW + 2_000, 'r')).toEqual({ ok: false, reason: 'expired' });
    const row = sqlite.query(`SELECT used_at FROM enrollment_authorities WHERE id = ?`).get(issued.id) as { used_at: number | null };
    expect(row.used_at).toBeNull();
  });

  it('refuses a revoked key, and revoking a spent key reports no change', async () => {
    const { db } = store();
    const a = await issueEnrollmentAuthority(db, NOW);
    expect(await revokeEnrollmentAuthority(db, a.id, NOW)).toEqual({ revoked: true });
    expect(await spendEnrollmentAuthority(db, a.key, NOW, 'r')).toEqual({ ok: false, reason: 'revoked' });

    const b = await issueEnrollmentAuthority(db, NOW);
    await spendEnrollmentAuthority(db, b.key, NOW, 'r');
    expect(await revokeEnrollmentAuthority(db, b.id, NOW)).toEqual({ revoked: false });
  });

  it('refuses an unknown key, and text that is not a key at all', async () => {
    const { db } = store();
    expect(await spendEnrollmentAuthority(db, 'A'.repeat(43), NOW, 'r')).toEqual({ ok: false, reason: 'unknown' });
    expect(await spendEnrollmentAuthority(db, 'not-a-key', NOW, 'r')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('is never a credential: spending it authenticates nothing by itself', async () => {
    const { db, sqlite } = store();
    const issued = await issueEnrollmentAuthority(db, NOW);
    await spendEnrollmentAuthority(db, issued.key, NOW, 'r');
    // Spending mints no credential — the join route does that, deliberately separately.
    expect((sqlite.query(`SELECT COUNT(*) c FROM member_credentials`).get() as { c: number }).c).toBe(0);
  });
});
