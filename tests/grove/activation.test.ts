import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import YAML from 'yaml';
import { saveConfig, loadConfig, loadMergedConfig } from '@myco/config/loader.js';
import { MycoConfigSchema } from '@myco/config/schema.js';
import { openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  activateProjectMigration,
  activationMarkerPath,
} from '@myco/grove/activation.js';
import { createGrove, setDefaultGrove } from '@myco/grove/registry.js';
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
    // Simulate the legacy on-disk shape (team config in project
    // myco.yaml). saveConfig now strips Grove-tier fields via
    // ProjectConfigSchema, so write the YAML directly to set up the
    // pre-migration state activateProjectMigration is meant to
    // handle. The activation flow should detect team here and
    // promote it to the Grove tier.
    fs.writeFileSync(
      path.join(vaultDir, 'myco.yaml'),
      YAML.stringify({
        version: 3,
        team: {
          enabled: true,
          worker_url: 'https://team.example.com',
          team_id: 'legacy-team',
        },
      }),
      'utf-8',
    );

    const result = activateProjectMigration({
      projectRoot,
      groveRef: grove.slug,
      mycoHome,
    });

    expect(result.dry_run).toBe(false);
    expect(result.team_sync_disabled).toBe(false);
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
    // After the three-tier split, team config moved from project to Grove
    // tier — read it from the merged view scoped to the activated Grove.
    expect(loadMergedConfig(vaultDir, { groveId: grove.id, mycoHome }).team.enabled).toBe(true);

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

  it('defaults activation to the machine default Grove when no Grove is supplied', () => {
    createGrove('Dogfood', mycoHome);
    const defaultGrove = createGrove('Default Projects', mycoHome);
    setDefaultGrove(defaultGrove.id, mycoHome);

    const result = activateProjectMigration({
      projectRoot,
      mycoHome,
      dryRun: true,
    });

    expect(result.grove.id).toBe(defaultGrove.id);
    expect(result.dry_run).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, 'project.toml'))).toBe(false);
    expect(listRegisteredProjects(defaultGrove.id, mycoHome)).toEqual([]);
  });

  it('normalizes older source schemas through a snapshot without mutating the source DB', () => {
    const grove = createGrove('Default Projects', mycoHome);
    downgradeSourceAgentRunsToRuntime(vaultDir);
    const sourceDbPath = path.join(vaultDir, 'myco.db');

    expect(tableColumns(sourceDbPath, 'agent_runs')).toContain('runtime');
    expect(tableColumns(sourceDbPath, 'agent_runs')).not.toContain('harness');
    expect(latestSchemaVersion(sourceDbPath)).toBe(28);

    const result = activateProjectMigration({
      projectRoot,
      groveRef: grove.id,
      mycoHome,
      dryRun: true,
    });

    expect(result.import_result?.agent_runs).toBe(1);
    expect(result.validation?.integrity_check).toBe('ok');
    expect(tableColumns(sourceDbPath, 'agent_runs')).toContain('runtime');
    expect(tableColumns(sourceDbPath, 'agent_runs')).not.toContain('harness');
    expect(latestSchemaVersion(sourceDbPath)).toBe(28);
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

function downgradeSourceAgentRunsToRuntime(vaultDir: string): void {
  const db = openDatabase(path.join(vaultDir, 'myco.db'));
  try {
    db.prepare(
      `INSERT INTO agent_runs (
         id, agent_id, task, instruction, status, harness, provider, model
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'legacy-run',
      'myco-agent',
      'vault-evolve',
      'older source schema',
      'completed',
      'openai',
      'openai',
      'gpt-test',
    );
    db.prepare('ALTER TABLE agent_runs RENAME COLUMN harness TO runtime').run();
    db.prepare('DELETE FROM schema_version').run();
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(28, 120);
  } finally {
    db.close();
  }
}

function tableColumns(dbPath: string, table: string): string[] {
  const db = openDatabase(dbPath);
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function latestSchemaVersion(dbPath: string): number {
  const db = openDatabase(dbPath);
  try {
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number };
    return row.version;
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
