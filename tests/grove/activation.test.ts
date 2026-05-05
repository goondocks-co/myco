import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { saveConfig, loadConfig } from '@myco/config/loader.js';
import { MycoConfigSchema } from '@myco/config/schema.js';
import { openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  activateProjectMigration,
  activationMarkerPath,
} from '@myco/grove/activation.js';
import { createGrove } from '@myco/grove/registry.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { listRegisteredProjects } from '@myco/grove/registry.js';
import { requestContextFromEnvironment } from '@myco/tools/request-context.js';

describe('Grove project activation', () => {
  let tmpDir: string;
  let mycoHome: string;
  let projectRoot: string;
  let vaultDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-grove-activation-'));
    mycoHome = path.join(tmpDir, 'home');
    projectRoot = path.join(tmpDir, 'project');
    vaultDir = resolveProjectVaultDir(projectRoot);
    fs.mkdirSync(vaultDir, { recursive: true });
    process.env.MYCO_HOME = mycoHome;
    seedLegacyVault(vaultDir, projectRoot);
  });

  afterEach(() => {
    delete process.env.MYCO_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dry-runs import validation without writing project binding state', () => {
    const grove = createGrove('Myco Dogfood', mycoHome);

    const result = activateProjectMigration({
      projectRoot,
      groveRef: grove.id,
      mycoHome,
      dryRun: true,
    });

    expect(result.dry_run).toBe(true);
    expect(result.import_result?.sessions).toBe(1);
    expect(result.import_result?.plans).toBe(1);
    expect(result.validation?.integrity_check).toBe('ok');
    expect(fs.existsSync(path.join(vaultDir, 'project.toml'))).toBe(false);
    expect(fs.existsSync(activationMarkerPath(vaultDir))).toBe(false);
    expect(listRegisteredProjects(grove.id, mycoHome)).toEqual([]);

    const targetDb = openDatabase(resolveGroveDbPath(grove.id, mycoHome));
    try {
      expect(countRows(targetDb, 'sessions')).toBe(0);
      expect(countRows(targetDb, 'plans')).toBe(0);
    } finally {
      targetDb.close();
    }
  });

  it('activates a project only after import validation and resolves future requests to the Grove DB', () => {
    const grove = createGrove('Myco Dogfood', mycoHome);
    saveConfig(vaultDir, MycoConfigSchema.parse({
      version: 3,
      team: {
        enabled: true,
        worker_url: 'https://team.example.com',
        team_id: 'legacy-team',
      },
    }));

    const result = activateProjectMigration({
      projectRoot,
      groveRef: grove.slug,
      mycoHome,
    });

    expect(result.dry_run).toBe(false);
    expect(result.team_sync_disabled).toBe(true);
    expect(result.import_result?.sessions).toBe(1);
    expect(result.import_result?.plans).toBe(1);
    expect(result.validation?.embedded_rows_pending.sessions).toBe(0);

    const manifest = parseToml(fs.readFileSync(path.join(vaultDir, 'project.toml'), 'utf-8')) as Record<string, any>;
    expect(manifest.project.id).toBe(result.project_id);
    expect(manifest.grove.slug).toBe(grove.slug);
    expect(manifest.grove.binding_id).toBe(result.grove_binding_id);
    expect(listRegisteredProjects(grove.id, mycoHome)).toMatchObject([
      {
        project_id: result.project_id,
        root: projectRoot,
        binding_id: result.grove_binding_id,
      },
    ]);

    const marker = JSON.parse(fs.readFileSync(result.marker_path, 'utf-8')) as Record<string, any>;
    expect(marker.status).toBe('activated');
    expect(marker.project_id).toBe(result.project_id);
    expect(marker.grove_id).toBe(grove.id);
    expect(loadConfig(vaultDir).team.enabled).toBe(false);

    const requestContext = requestContextFromEnvironment({}, vaultDir);
    expect(requestContext.groveId).toBe(grove.id);
    expect(requestContext.projectId).toBe(result.project_id);
    expect(requestContext.databasePath).toBe(result.target_db_path);

    const targetDb = openDatabase(result.target_db_path);
    try {
      expect(countProjectRows(targetDb, 'sessions', result.project_id)).toBe(1);
      expect(countProjectRows(targetDb, 'plans', result.project_id)).toBe(1);
      expect(countEmbeddedProjectRows(targetDb, 'sessions', result.project_id)).toBe(0);
      expect(countEmbeddedProjectRows(targetDb, 'plans', result.project_id)).toBe(0);
    } finally {
      targetDb.close();
    }

    const second = activateProjectMigration({
      projectRoot,
      groveRef: grove.id,
      mycoHome,
    });
    expect(second.already_activated).toBe(true);

    const afterRerunDb = openDatabase(result.target_db_path);
    try {
      expect(countProjectRows(afterRerunDb, 'sessions', result.project_id)).toBe(1);
      expect(countProjectRows(afterRerunDb, 'plans', result.project_id)).toBe(1);
    } finally {
      afterRerunDb.close();
    }
  });
});

function seedLegacyVault(vaultDir: string, projectRoot: string): void {
  const db = openDatabase(path.join(vaultDir, 'myco.db'));
  try {
    createSchema(db);
    db.prepare(
      `INSERT INTO agents (
         id, name, source, enabled, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run('myco-agent', 'Myco Agent', 'built-in', 1, 100);
    db.prepare(
      `INSERT INTO sessions (
         id, agent, project_root, branch, started_at, status,
         created_at, embedded, machine_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('legacy-session', 'codex', projectRoot, 'main', 110, 'completed', 110, 1, 'source-machine');
    db.prepare(
      `INSERT INTO plans (
         id, logical_key, status, author, title, content, source_path,
         tags, session_id, content_hash, processed, created_at,
         updated_at, embedded, machine_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'legacy-plan',
      'legacy:plan',
      'active',
      'codex',
      'Legacy Plan',
      '# Legacy Plan\n\nPreserve this plan.',
      null,
      'grove,migration',
      'legacy-session',
      'hash-plan',
      1,
      120,
      121,
      1,
      'source-machine',
    );
  } finally {
    db.close();
  }
}

function countRows(db: Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function countProjectRows(db: Database, table: string, projectId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(projectId) as { count: number };
  return row.count;
}

function countEmbeddedProjectRows(db: Database, table: string, projectId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ? AND COALESCE(embedded, 0) <> 0`,
  ).get(projectId) as { count: number };
  return row.count;
}
