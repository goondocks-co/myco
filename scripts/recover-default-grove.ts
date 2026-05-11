#!/usr/bin/env bun
/**
 * One-off recovery for the Default Grove after the 2026-05 smoke-test
 * data loss. The previous claim/release flow used a SQL-dump snapshot
 * with a line-based restore parser; any row whose text payload spanned
 * multiple lines was silently dropped on restore, and the verify phase
 * parsed the dump's own (N rows) comments rather than counting from
 * live source/target DBs, so the broken dump and the broken restore
 * agreed with each other and "succeeded."
 *
 * What this restores:
 *   - ten-second-tom: 42 spores, 706 activities, 36 prompt_batches,
 *     1 canopy_map, 3 digest_extracts (per the 2026-05-10 routine backup).
 *   - All other projects in Default: their full 2026-05-10 row counts.
 *
 * What this CAN'T restore:
 *   - Work done between 2026-05-10 and now for the affected projects.
 *     That data was already gone from disk by the time the loss was
 *     detected; the May 10 backup is the latest pre-loss snapshot.
 *
 * Procedure:
 *   1. Verify dev + prod daemons are stopped.
 *   2. Make a safety copy of the live Default DB.
 *   3. Open the live Default DB.
 *   4. For each project_id present in the May 10 backup, DELETE the
 *      project-scoped rows from the live DB so INSERT OR IGNORE
 *      replays cleanly.
 *   5. Invoke restoreBackup() against the May 10 backup.
 *   6. Print before/after row counts for every project in the backup.
 *
 * Do NOT run twice — repeated runs would re-wipe and replay, no harm
 * intended but pointless. Delete this script once Chris confirms recovery.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '@myco/db/client.js';
import { BACKUP_TABLES, restoreBackup } from '@myco/daemon/backup.js';

const DEFAULT_GROVE_ID = 'grove_65b606b9665228ac5f1812d645cdf6fe';
const DEFAULT_DB = `/Users/chris/.myco/groves/${DEFAULT_GROVE_ID}/myco.db`;
const BACKUP_FILE = '/Users/chris/myco_backups/myco/default/sirkirby_5a2d54af__1778436249.sql';

const KNOWN_PROJECTS: Record<string, string> = {
  proj_a12b453db5799dcbc855e9f9676929ab: 'ten-second-tom',
  proj_604bd09a08461faa369b0c8430be1a07: 'collagen-advocacy',
  proj_668c99db2e1efb42727bd2ab938e77d1: 'unifi-network-rules',
  proj_924c23d88ee34933408e8c3e07f6682e: 'unifi-mcp',
  proj_fb4cafae69be298f9fa8ce4c7f437f18: 'myco',
  proj_6899ee2b96ce8fbc9c7ab514d02ece25: 'website',
};

const COUNT_TABLES = ['spores', 'activities', 'prompt_batches', 'canopy_maps', 'digest_extracts', 'sessions'] as const;

function assertNoDaemon(): void {
  try {
    const out = execFileSync('pgrep', ['-fl', 'myco daemon'], { encoding: 'utf-8' });
    if (out.trim()) {
      console.error('Found running myco daemon(s):');
      console.error(out);
      console.error('Stop all daemons before running this recovery script.');
      process.exit(1);
    }
  } catch {
    // pgrep returns non-zero when nothing matched; that's what we want.
  }
}

function countByProject(db: ReturnType<typeof openDatabase>, table: string): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const rows = db
      .prepare(`SELECT project_id AS pid, COUNT(*) AS n FROM ${table} GROUP BY project_id`)
      .all() as Array<{ pid: string; n: number }>;
    for (const row of rows) out.set(row.pid, row.n);
  } catch {
    // Table may not exist; ignore.
  }
  return out;
}

function projectIdsInBackup(backupContent: string): Set<string> {
  const ids = new Set<string>();
  const re = /'(proj_[a-f0-9]{32})'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(backupContent)) !== null) {
    ids.add(match[1]);
  }
  return ids;
}

function printCountTable(label: string, db: ReturnType<typeof openDatabase>): void {
  console.log(`\n=== ${label} ===`);
  const header = ['project_id (name)'.padEnd(60), ...COUNT_TABLES.map((t) => t.padStart(14))].join('');
  console.log(header);
  console.log('-'.repeat(header.length));
  const byProject = new Map<string, Record<string, number>>();
  for (const table of COUNT_TABLES) {
    const counts = countByProject(db, table);
    for (const [pid, n] of counts) {
      const row = byProject.get(pid) ?? {};
      row[table] = n;
      byProject.set(pid, row);
    }
  }
  for (const [pid, counts] of byProject) {
    const name = KNOWN_PROJECTS[pid] ?? '?';
    const line = [
      `${pid} (${name})`.padEnd(60),
      ...COUNT_TABLES.map((t) => String(counts[t] ?? 0).padStart(14)),
    ].join('');
    console.log(line);
  }
}

function main(): void {
  if (!fs.existsSync(DEFAULT_DB)) {
    console.error(`Default Grove DB not found: ${DEFAULT_DB}`);
    process.exit(1);
  }
  if (!fs.existsSync(BACKUP_FILE)) {
    console.error(`Recovery backup file not found: ${BACKUP_FILE}`);
    process.exit(1);
  }

  assertNoDaemon();

  const safety = `${DEFAULT_DB}.before-recovery-${Date.now()}`;
  console.log(`Safety copy: ${safety}`);
  fs.copyFileSync(DEFAULT_DB, safety);
  for (const suffix of ['-wal', '-shm']) {
    const live = `${DEFAULT_DB}${suffix}`;
    if (fs.existsSync(live)) {
      const dest = `${safety}${suffix}`;
      fs.copyFileSync(live, dest);
      fs.unlinkSync(live);
    }
  }

  const db = openDatabase(DEFAULT_DB);
  printCountTable('BEFORE recovery', db);

  const backupContent = fs.readFileSync(BACKUP_FILE, 'utf-8');
  const projectsInBackup = projectIdsInBackup(backupContent);
  console.log(`\nProjects present in backup: ${projectsInBackup.size}`);
  for (const pid of projectsInBackup) {
    console.log(`  ${pid} (${KNOWN_PROJECTS[pid] ?? '?'})`);
  }

  db.run('PRAGMA foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      const placeholders = Array.from({ length: projectsInBackup.size }, () => '?').join(', ');
      const params = Array.from(projectsInBackup);
      for (const table of BACKUP_TABLES) {
        try {
          if (table === 'team_members') {
            db.prepare(`DELETE FROM ${table}`).run();
          } else {
            db.prepare(
              `DELETE FROM ${table} WHERE project_id IN (${placeholders})`,
            ).run(...params);
          }
        } catch (err) {
          console.warn(`  skip ${table}: ${(err as Error).message}`);
        }
      }
      try {
        db.prepare(
          `DELETE FROM entity_mentions WHERE project_id IN (${placeholders})`,
        ).run(...params);
      } catch {
        // not all schema versions have entity_mentions; skip.
      }
    });
    tx();
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }

  console.log('\nRestoring May 10 backup...');
  const t0 = Date.now();
  const result = restoreBackup(db, BACKUP_FILE);
  console.log(`Restore complete in ${(Date.now() - t0) / 1000}s.`);
  console.log(`Total restored: ${result.total_restored}, skipped: ${result.total_skipped}`);

  printCountTable('AFTER recovery', db);
  db.close();
}

main();
