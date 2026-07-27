/**
 * The front door must not MIGRATE a project that is mid-move — even for a
 * read op that write admission otherwise admits.
 *
 * `runWithRequestDatabase` opens the Grove DB in-process and runs
 * `createSchema` when a caller builds `MycoTools` WITHOUT `resolveDatabase`.
 * Running the migration chain during a residency push alters tables under an
 * in-flight transfer, so reads are admitted but migrating is not.
 *
 * SCOPE, so nobody mistakes this for the load-bearing gate: no production
 * wiring reaches this branch today. `mcp/http.ts` and
 * `daemon/external-listener.ts` both pass `resolveDatabase`, and the CLI is
 * an MCP client of `/mcp` rather than an in-process caller
 * (decision-14e572a3). These cases therefore cover a configuration
 * production does not currently use — they exist so a re-added
 * out-of-daemon caller cannot migrate a leased project. What actually
 * protects the tool surface is the `callTool` gate, covered in
 * `front-door-admission.test.ts`.
 *
 * Uses a real on-disk SQLite file so the version probe and the migration
 * are the real ones, not stubs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMycoTools } from '@myco/tools/index.js';
import { openDatabase } from '@myco/db/client.js';
import { createSchema, isSchemaMigrationPending, SCHEMA_VERSION } from '@myco/db/schema.js';
import { acquireProjectLease } from '@myco/grove/project-lease.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const PROJECT = assertGroveProjectId('proj_' + '8'.repeat(32));

describe('tool front door — never migrates a project mid-move', () => {
  let mycoHome: string;
  let dbPath: string;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-front-door-mig-'));
    fs.mkdirSync(path.join(mycoHome, 'project', '.myco'), { recursive: true });
    dbPath = path.join(mycoHome, 'grove.db');
  });
  afterEach(() => {
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  function context(): MycoRequestContext {
    return {
      projectRoot: path.join(mycoHome, 'project'),
      callerRoot: null,
      projectId: PROJECT,
      groveId: 'grv_' + '0'.repeat(32),
      machineId: 'test_machine',
      sessionId: null,
      projectVaultDir: path.join(mycoHome, 'project', '.myco'),
      databasePath: dbPath,
      source: 'explicit',
      tenancySource: 'caller',
    };
  }

  /** No `resolveDatabase`, so the real open + migrate path runs. */
  function tools() {
    const client = new Proxy({}, {
      get() { throw new Error('handler reached the client'); },
    }) as DaemonClient;
    return createMycoTools(path.join(mycoHome, 'project'), client, {
      requestContext: context(),
      mycoHome,
    });
  }

  /** A vault recorded at an older version, so a migration is pending. */
  function seedStaleVault(): void {
    const db = openDatabase(dbPath);
    createSchema(db, 'test_machine');
    db.prepare('DELETE FROM schema_version').run();
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION - 1, 0);
    db.close();
  }

  it('the probe agrees with reality in both directions', () => {
    const fresh = openDatabase(dbPath);
    expect(isSchemaMigrationPending(fresh), 'a schema-less DB needs building').toBe(true);
    createSchema(fresh, 'test_machine');
    expect(isSchemaMigrationPending(fresh), 'a current DB has nothing pending').toBe(false);
    fresh.close();

    seedStaleVault();
    const stale = openDatabase(dbPath);
    expect(isSchemaMigrationPending(stale), 'an older recorded version has a migration pending').toBe(true);
    stale.close();
  });

  it('refuses a READ that would migrate a leased project, and leaves the version untouched', async () => {
    seedStaleVault();
    acquireProjectLease(PROJECT, 'residency-detach', 'detaching', null, mycoHome, testPerUserLockNamespace);

    let thrown: unknown;
    try {
      await tools().callTool('myco_sessions', { op: 'list' });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as { code?: string }).code).toBe('project_lease_held');

    // The point of the refusal: the vault was NOT migrated.
    const db = openDatabase(dbPath);
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number };
    db.close();
    expect(row.version).toBe(SCHEMA_VERSION - 1);
  });

  it('migrates normally when the same project is NOT leased (the refusal is lease-conditional)', async () => {
    seedStaleVault();

    try {
      await tools().callTool('myco_sessions', { op: 'list' });
    } catch {
      // The handler fails on the stub client; the migration already ran.
    }

    const db = openDatabase(dbPath);
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number };
    db.close();
    expect(row.version).toBe(SCHEMA_VERSION);
  });

  it('admits a read on a leased project when no migration is pending', async () => {
    const seeded = openDatabase(dbPath);
    createSchema(seeded, 'test_machine');
    seeded.close();
    acquireProjectLease(PROJECT, 'residency-detach', 'detaching', null, mycoHome, testPerUserLockNamespace);

    let thrown: unknown;
    try {
      await tools().callTool('myco_sessions', { op: 'list' });
    } catch (error) {
      thrown = error;
    }

    // Reached the handler rather than being lease-refused.
    expect((thrown as { code?: string })?.code).not.toBe('project_lease_held');
  });
});
