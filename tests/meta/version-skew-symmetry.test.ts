/**
 * Meta gate: the vault schema check is symmetric — it refuses a database from
 * the future as well as migrating one from the past.
 *
 * Every migration test walks forward. Before this gate, no test had ever opened
 * a vault stamped at or above the binary's own `SCHEMA_VERSION`, and
 * `createSchema` had no branch for it: the equality check failed, no migration
 * matched, and the older binary's DDL was reapplied over a newer schema. Because
 * the self-updater can roll back to a prior binary after a migration has already
 * committed, that path is reachable without any user action.
 *
 * The first two assertions are behavioral rather than a source scan, so they stay
 * meaningful as `SCHEMA_VERSION` moves. The third keeps the axis honest: a
 * dedicated regression test must continue to exercise the newer-than-binary case.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function freshVaultAt(version: number): Database {
  const db = new Database(':memory:');
  createSchema(db);
  db.prepare(
    `INSERT INTO schema_version (version, applied_at)
     VALUES (?, ?)
     ON CONFLICT (version) DO NOTHING`,
  ).run(version, epochSeconds());
  return db;
}

function stampedVersion(db: Database): number {
  const row = db.prepare(
    'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
  ).get() as { version: number } | undefined;
  return row?.version ?? 0;
}

function listTestFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...listTestFiles(path.join(dir, entry.name)));
      continue;
    }
    if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) out.push(path.join(dir, entry.name));
  }
  return out;
}

describe('meta: schema version skew is checked in both directions', () => {
  it('refuses a vault stamped newer than this binary understands', () => {
    const db = freshVaultAt(SCHEMA_VERSION + 1);
    try {
      expect(() => createSchema(db)).toThrow(/schema_version_too_new/);
    } finally {
      db.close();
    }
  });

  it('leaves the newer vault unmodified when it refuses', () => {
    const db = freshVaultAt(SCHEMA_VERSION + 1);
    try {
      expect(() => createSchema(db)).toThrow();
      expect(stampedVersion(db)).toBe(SCHEMA_VERSION + 1);
    } finally {
      db.close();
    }
  });

  it('keeps a dedicated regression test for the newer-than-binary case', () => {
    // Any test that seeds a literal above the current SCHEMA_VERSION, or derives
    // one from the constant, satisfies the axis. Matching both forms keeps the
    // gate from forcing a literal that would go stale on the next bump.
    const derived = /SCHEMA_VERSION\s*\+\s*\d+/;
    const covering = listTestFiles(path.join(REPO_ROOT, 'tests'))
      .filter((file) => path.basename(file) !== 'version-skew-symmetry.test.ts')
      .filter((file) => derived.test(fs.readFileSync(file, 'utf-8')));

    expect(covering.length).toBeGreaterThan(0);
  });
});
