/**
 * Backup round-trip coverage for project-scoped canopy tables.
 *
 * Asserts that `canopy_entries` and `canopy_maps` survive create+restore.
 * The canopy tables only became part of the project-scoped backup surface
 * once `BACKUP_TABLES` was derived from `GROVE_PROJECT_SCOPED_TABLES`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { createBackup, restoreBackup } from '@myco/backup/engine.js';
import { assertGroveProjectId, createProjectId, projectScope } from '@myco/grove/ids.js';

const MACHINE_ID = 'testuser_aaaa1111';

function makeTmpBackupDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'backup-canopy-'));
}

describe('backup round-trip — canopy tables', () => {
  let tmpDir: string;

  beforeAll(() => {
    setupTestDb();
  });
  afterAll(() => {
    teardownTestDb();
  });
  beforeEach(() => {
    cleanTestDb();
    tmpDir = makeTmpBackupDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('canopy_entries and canopy_maps round-trip via backup/restore', () => {
    const projectId = assertGroveProjectId(createProjectId());
    const now = 1700000000;
    const db = getDatabase();

    db.prepare(`
      INSERT INTO canopy_entries
        (project_id, machine_id, path, content_hash, size_bytes,
         token_estimate, line_count, mechanical_updated_at)
      VALUES (?, 'local', 'src/foo.ts', 'hash-1', 100, 50, 10, ?)
    `).run(projectId, now);

    db.prepare(`
      INSERT INTO canopy_maps
        (project_id, machine_id, content, inputs_hash, generated_at, token_estimate)
      VALUES (?, 'local', 'map-content', 'hash-2', ?, 1000)
    `).run(projectId, now);

    const backupPath = createBackup(db, tmpDir, MACHINE_ID);

    // Wipe and restore into the same DB instance.
    cleanTestDb();
    const restoreResult = restoreBackup(db, backupPath);
    expect(restoreResult.total_restored).toBeGreaterThan(0);

    const entries = db
      .prepare('SELECT * FROM canopy_entries WHERE project_id = ?')
      .all(projectId) as unknown[];
    expect(entries).toHaveLength(1);

    const maps = db
      .prepare('SELECT * FROM canopy_maps WHERE project_id = ?')
      .all(projectId) as unknown[];
    expect(maps).toHaveLength(1);
  });

  it('project-scoped backup includes only the target project rows', () => {
    const projectA = assertGroveProjectId(createProjectId());
    const projectB = assertGroveProjectId(createProjectId());
    const now = 1700000000;
    const db = getDatabase();

    // Seed both projects with canopy rows.
    for (const projectId of [projectA, projectB]) {
      db.prepare(`
        INSERT INTO canopy_entries
          (project_id, machine_id, path, content_hash, size_bytes,
           token_estimate, line_count, mechanical_updated_at)
        VALUES (?, 'local', 'src/foo.ts', ?, 100, 50, 10, ?)
      `).run(projectId, `hash-${projectId}`, now);
      db.prepare(`
        INSERT INTO canopy_maps
          (project_id, machine_id, content, inputs_hash, generated_at, token_estimate)
        VALUES (?, 'local', ?, ?, ?, 1000)
      `).run(projectId, `map-${projectId}`, `inputs-${projectId}`, now);
    }

    const slug = 'project-a-slug';
    const backupPath = createBackup(
      db,
      tmpDir,
      MACHINE_ID,
      projectScope(projectA),
      slug,
    );

    // Filename matches the project-scoped pattern: machine__slug__timestamp.sql
    const filename = path.basename(backupPath);
    expect(filename).toMatch(
      new RegExp(`^${MACHINE_ID}__${slug}__[0-9]+\\.sql$`),
    );

    // Header records the project scope.
    const content = fs.readFileSync(backupPath, 'utf-8');
    expect(content).toContain(`-- scope: project=${projectA}`);

    // Wipe and restore — only project A's rows should come back.
    cleanTestDb();
    restoreBackup(db, backupPath);

    const entriesA = db
      .prepare('SELECT * FROM canopy_entries WHERE project_id = ?')
      .all(projectA) as unknown[];
    const entriesB = db
      .prepare('SELECT * FROM canopy_entries WHERE project_id = ?')
      .all(projectB) as unknown[];
    expect(entriesA).toHaveLength(1);
    expect(entriesB).toHaveLength(0);

    const mapsA = db
      .prepare('SELECT * FROM canopy_maps WHERE project_id = ?')
      .all(projectA) as unknown[];
    const mapsB = db
      .prepare('SELECT * FROM canopy_maps WHERE project_id = ?')
      .all(projectB) as unknown[];
    expect(mapsA).toHaveLength(1);
    expect(mapsB).toHaveLength(0);
  });
});
