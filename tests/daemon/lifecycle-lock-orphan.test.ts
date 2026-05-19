/**
 * Regression test for the lifecycle lock: when another daemon already
 * holds the lock and has an open SQLite write transaction, a second
 * `myco daemon` invocation must exit cleanly without touching the schema.
 *
 * Authored as Phase 0 of plan `10c7cdc140a99491`. The test imports the
 * to-be-built `LifecycleLock` primitive and `attemptDaemonStartup`
 * entry — both fail to resolve today, which is the intended FAIL state
 * for Phase 0. Phase 1 lands the lock module; Phase 2 lands the entry
 * function that uses it. After both phases, this test passes without
 * structural changes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDatabase, closeDatabase, openDatabase } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

const supportsCwdIntrospection =
  process.platform === 'linux' || process.platform === 'darwin';

const ORPHAN_HELPER = path.resolve('tests/helpers/lifecycle-lock-orphan-helper.ts');

interface SchemaSnapshot {
  schemaVersion: number;
  promptBatchesCount: number;
  activitiesCount: number;
  sessionsCount: number;
  ftsTriggerNames: string[];
}

function snapshotSchema(dbPath: string): SchemaSnapshot {
  const db = openDatabase(dbPath);
  try {
    const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const count = (table: string) =>
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    return {
      schemaVersion: v.v ?? 0,
      promptBatchesCount: count('prompt_batches'),
      activitiesCount: count('activities'),
      sessionsCount: count('sessions'),
      ftsTriggerNames: triggers.map((t) => t.name),
    };
  } finally {
    db.close();
  }
}

describe.skipIf(!supportsCwdIntrospection)(
  'lifecycle lock — orphan SQLite holder',
  () => {
    let tmpDir: string;
    let dbPath: string;
    let lockPath: string;
    let orphan: ChildProcess | null = null;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-lock-'));
      dbPath = path.join(tmpDir, 'myco.db');
      lockPath = path.join(tmpDir, 'daemon.lock');

      // Bootstrap the schema once so the orphan can begin a transaction
      // against existing tables.
      const db = initDatabase(dbPath);
      createSchema(db, 'test-machine');
      closeDatabase();
    });

    afterEach(() => {
      if (orphan && orphan.pid) {
        try { process.kill(orphan.pid, 'SIGKILL'); } catch { /* already dead */ }
      }
      orphan = null;
      closeDatabase();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    async function spawnOrphanHoldingLockAndSqlite(): Promise<number> {
      orphan = spawn(process.execPath, ['run', ORPHAN_HELPER, lockPath, dbPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: process.cwd(),
      });
      const orphanPid = orphan.pid!;
      expect(orphanPid).toBeGreaterThan(0);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('orphan did not become ready within 5s')),
          5000,
        );
        orphan!.stdout!.on('data', (chunk: Buffer) => {
          if (chunk.toString('utf-8').includes('READY')) {
            clearTimeout(timer);
            resolve();
          }
        });
        orphan!.stderr!.on('data', (chunk: Buffer) => {
          process.stderr.write(`orphan stderr: ${chunk.toString('utf-8')}`);
        });
        orphan!.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`orphan exited prematurely with code ${code}`));
        });
      });
      return orphanPid;
    }

    it('refuses the second daemon attempt and leaves the schema untouched', async () => {
      const orphanPid = await spawnOrphanHoldingLockAndSqlite();
      const before = snapshotSchema(dbPath);

      // The to-be-built daemon-startup entry. Today this import throws;
      // Phase 2 lands the function and this test starts running for real.
      const { attemptDaemonStartup } = await import('@myco/daemon/lifecycle-lock-startup.js');

      const result = await attemptDaemonStartup({
        databasePath: dbPath,
        lockPath,
      });

      expect(result.outcome).toBe('refused');
      expect(result.holderPid).toBe(orphanPid);
      expect(result.reason ?? '').toMatch(/another daemon|lock|running/i);

      // Schema state is byte-identical to the pre-call snapshot. The
      // critical invariant from Phase 0: the second daemon refused
      // BEFORE any DB work touched the schema. Compare every field.
      const after = snapshotSchema(dbPath);
      expect(after.schemaVersion).toBe(before.schemaVersion);
      expect(after.schemaVersion).toBe(SCHEMA_VERSION);
      expect(after.promptBatchesCount).toBe(before.promptBatchesCount);
      expect(after.activitiesCount).toBe(before.activitiesCount);
      expect(after.sessionsCount).toBe(before.sessionsCount);
      expect(after.ftsTriggerNames).toEqual(before.ftsTriggerNames);
    }, 15_000);

    it('proceeds normally once the orphan releases the lock', async () => {
      const orphanPid = await spawnOrphanHoldingLockAndSqlite();
      // Kill the orphan; both flock and SQLite write tx release at OS-level.
      process.kill(orphanPid, 'SIGKILL');
      await new Promise<void>((resolve) => {
        if (!orphan) return resolve();
        orphan.on('exit', () => resolve());
      });

      const { attemptDaemonStartup } = await import('@myco/daemon/lifecycle-lock-startup.js');

      const result = await attemptDaemonStartup({
        databasePath: dbPath,
        lockPath,
      });

      expect(result.outcome).toBe('acquired');
      expect(result.lock).toBeDefined();
      // Caller is now the lock holder. Release for cleanup.
      result.lock!.release();
    }, 15_000);
  },
);
