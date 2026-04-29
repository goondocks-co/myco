import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { MIGRATIONS } from '@myco/db/migrations.js';

/**
 * Migration v28 retroactively cleans up canopy_entries rows that the new
 * Myco baseline would now reject — the screenshot regression where `.git/`
 * and `.venv/` paths leaked into the index because no layer claimed
 * authority over them. Belt-and-suspenders alongside the live matcher,
 * which would also tombstone these rows on the next full scan.
 */

function seedCanopyRow(db: Database, projectId: string, p: string): void {
  db.prepare(
    `INSERT INTO canopy_entries (
      project_id, machine_id, path, content_hash, size_bytes,
      token_estimate, line_count, mechanical_updated_at,
      llm_description, llm_updated_at, embedded
    ) VALUES (?, 'local', ?, 'h', 100, 20, 5, 1700000000, NULL, NULL, 0)`,
  ).run(projectId, p);
}

describe('migration v28: canopy exclude baseline cleanup', () => {
  it('purges .git, .venv, node_modules, __pycache__, lockfile rows', () => {
    const db = new Database(':memory:');
    // Install at v27 first so the migration to 28 has rows to clean.
    createSchema(db);
    db.prepare(`UPDATE schema_version SET version = 27 WHERE version = ?`).run(SCHEMA_VERSION);

    // Seed the kinds of paths the screenshot showed leaking through.
    const baselineHits = [
      '.git/COMMIT_EDITMSG',
      '.git/objects/ab/cdef0123456789',
      '.venv/bin/alembic',
      '.venv/lib/python3.13/site-packages/foo.py',
      'node_modules/react/index.js',
      'apps/api/src/__pycache__/foo.cpython-313.pyc',
      '.pytest_cache/v/cache/lastfailed',
      'dist/bundle.js',
      'package-lock.json',
      'apps/web/yarn.lock',
      'vendor/foo.lock',
      '.DS_Store',
    ];
    const survivors = [
      'src/index.ts',
      'apps/api/src/main.py',
      'README.md',
      'docs/plan.md',
    ];
    for (const p of [...baselineHits, ...survivors]) {
      seedCanopyRow(db, 'proj-1', p);
    }

    // Run the migration directly (createSchema would replay all migrations
    // through SCHEMA_VERSION; we want to assert this single step's effect).
    const v28 = MIGRATIONS.find((m) => m.version === 28)!;
    v28.migrate(db, 'local');

    const remaining = db
      .prepare(`SELECT path FROM canopy_entries WHERE project_id = 'proj-1' ORDER BY path`)
      .all() as Array<{ path: string }>;
    const remainingPaths = remaining.map((r) => r.path).sort();
    expect(remainingPaths).toEqual(survivors.slice().sort());
  });

  it('leaves the schema_version stamped at 28', () => {
    const db = new Database(':memory:');
    createSchema(db);
    db.prepare(`UPDATE schema_version SET version = 27 WHERE version = ?`).run(SCHEMA_VERSION);
    const v28 = MIGRATIONS.find((m) => m.version === 28)!;
    v28.migrate(db, 'local');
    const row = db
      .prepare(`SELECT MAX(version) AS v FROM schema_version`)
      .get() as { v: number };
    expect(row.v).toBe(28);
  });

  it('is a no-op when no canopy_entries rows match the baseline', () => {
    const db = new Database(':memory:');
    createSchema(db);
    db.prepare(`UPDATE schema_version SET version = 27 WHERE version = ?`).run(SCHEMA_VERSION);
    seedCanopyRow(db, 'proj-1', 'src/index.ts');
    seedCanopyRow(db, 'proj-1', 'README.md');
    const v28 = MIGRATIONS.find((m) => m.version === 28)!;
    expect(() => v28.migrate(db, 'local')).not.toThrow();
    const count = (db
      .prepare(`SELECT COUNT(*) AS n FROM canopy_entries`)
      .get() as { n: number }).n;
    expect(count).toBe(2);
  });
});
