import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, updateTeamConfig } from '@myco/config/loader.js';
import {
  loadProjectManifest,
  saveProjectManifest,
  type ProjectManifest,
} from '@myco/config/project-manifest.js';
import { openDatabase, openReadonly, type Database } from '@myco/db/client.js';
import { listImportMappingsForMigration } from '@myco/db/queries/migration-import-journal.js';
import { createSchema } from '@myco/db/schema.js';
import { getMachineId } from '@myco/daemon/machine-id.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { importProjectCoreRows, type ImportProjectCoreResult } from '@myco/grove/importer.js';
import { createGroveBindingId, createMigrationId, createProjectId } from '@myco/grove/ids.js';
import {
  resolveProjectVaultDir,
  resolveMycoHome,
} from '@myco/grove/paths.js';
import {
  findRegisteredProject,
  findRegisteredProjectByBinding,
  registerProjectInGrove,
  resolveGrove,
  type GroveRecord,
} from '@myco/grove/registry.js';

export const GROVE_ACTIVATION_MARKER = 'grove-activation.json';

export interface ActivateProjectMigrationInput {
  projectRoot: string;
  groveRef?: string;
  mycoHome?: string;
  dryRun?: boolean;
  projectName?: string;
  migrationId?: string;
  targetMachineId?: string | null;
}

export interface ActivationValidationSummary {
  target_counts: Record<string, number>;
  journal_mappings: number;
  journal_errors: number;
  embedded_rows_pending: Record<string, number>;
  integrity_check: string;
}

export interface ActivateProjectMigrationResult {
  migration_id: string;
  dry_run: boolean;
  already_activated: boolean;
  project_root: string;
  project_vault_dir: string;
  source_db_path: string;
  target_db_path: string;
  grove: GroveRecord;
  project_id: string;
  project_name: string;
  grove_binding_id: string;
  import_result: ImportProjectCoreResult | null;
  validation: ActivationValidationSummary | null;
  team_sync_disabled: boolean;
  marker_path: string;
}

interface ActivationMarker {
  status: 'activated';
  migration_id: string;
  project_root: string;
  project_id: string;
  project_name: string;
  grove_id: string;
  grove_slug: string;
  grove_binding_id: string;
  source_db_path: string;
  target_db_path: string;
  activated_at: string;
  import_result: ImportProjectCoreResult;
  validation: ActivationValidationSummary;
  team_sync_disabled: boolean;
  runtime_command_preserved: boolean;
}

interface PreparedIdentity {
  projectId: string;
  projectName: string;
  bindingId: string;
  manifest: ProjectManifest;
}

const PROJECT_SCOPED_RESULT_TABLES: ReadonlyArray<readonly [keyof ImportProjectCoreResult, string]> = [
  ['sessions', 'sessions'],
  ['prompt_batches', 'prompt_batches'],
  ['activities', 'activities'],
  ['attachments', 'attachments'],
  ['plans', 'plans'],
  ['artifacts', 'artifacts'],
  ['spores', 'spores'],
  ['entities', 'entities'],
  ['entity_mentions', 'entity_mentions'],
  ['resolution_events', 'resolution_events'],
  ['graph_edges', 'graph_edges'],
  ['agent_runs', 'agent_runs'],
  ['agent_reports', 'agent_reports'],
  ['agent_turns', 'agent_turns'],
  ['agent_run_write_intents', 'agent_run_write_intents'],
  ['skill_records', 'skill_records'],
  ['skill_candidates', 'skill_candidates'],
  ['skill_lineage', 'skill_lineage'],
  ['skill_usage', 'skill_usage'],
  ['canopy_entries', 'canopy_entries'],
  ['canopy_maps', 'canopy_maps'],
  ['digest_extracts', 'digest_extracts'],
  ['digest_extract_revisions', 'digest_extract_revisions'],
  ['cortex_instructions', 'cortex_instructions'],
  ['notifications', 'notifications'],
  ['log_entries', 'log_entries'],
];

const EMBEDDABLE_PROJECT_TABLES = [
  'sessions',
  'plans',
  'artifacts',
  'spores',
  'skill_records',
  'canopy_entries',
] as const;

class DryRunRollback extends Error {
  constructor() {
    super('dry-run rollback');
  }
}

interface SourceSnapshot {
  db: Database;
  cleanup: () => void;
}

export function activationMarkerPath(projectVaultDir: string): string {
  return path.join(projectVaultDir, 'migration', GROVE_ACTIVATION_MARKER);
}

export function activateProjectMigration(
  input: ActivateProjectMigrationInput,
): ActivateProjectMigrationResult {
  const projectRoot = path.resolve(input.projectRoot);
  const projectVaultDir = resolveProjectVaultDir(projectRoot);
  const sourceDbPath = path.join(projectVaultDir, 'myco.db');
  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`Legacy project database not found: ${sourceDbPath}`);
  }

  const mycoHome = input.mycoHome ?? resolveMycoHome();
  const grove = resolveGrove(input.groveRef, mycoHome);
  const markerPath = activationMarkerPath(projectVaultDir);
  const existingManifest = loadProjectManifest(projectVaultDir);
  const identity = prepareIdentity({
    existingManifest,
    grove,
    projectRoot,
    projectName: input.projectName,
    mycoHome,
  });
  const targetDbInfo = ensureGroveDatabase(grove.id, mycoHome);
  const existingMarker = readActivationMarker(markerPath);
  if (existingMarker) {
    assertExistingMarkerMatches(existingMarker, {
      projectRoot,
      sourceDbPath,
      groveId: grove.id,
      projectId: identity.projectId,
    });
    return {
      migration_id: existingMarker.migration_id,
      dry_run: Boolean(input.dryRun),
      already_activated: true,
      project_root: projectRoot,
      project_vault_dir: projectVaultDir,
      source_db_path: sourceDbPath,
      target_db_path: targetDbInfo.dbPath,
      grove,
      project_id: identity.projectId,
      project_name: identity.projectName,
      grove_binding_id: identity.bindingId,
      import_result: existingMarker.import_result,
      validation: existingMarker.validation,
      team_sync_disabled: existingMarker.team_sync_disabled,
      marker_path: markerPath,
    };
  }

  const migrationId = input.migrationId ?? createMigrationId();
  const targetMachineId = input.targetMachineId ?? getMachineId(projectVaultDir);
  const sourceSnapshot = openMigratedSourceSnapshot(sourceDbPath, targetMachineId);
  const targetDb = openDatabase(targetDbInfo.dbPath);
  let importResult: ImportProjectCoreResult | null = null;
  let validation: ActivationValidationSummary | null = null;
  let teamSyncDisabled = false;

  try {
    createSchema(targetDb);
    targetDb.transaction(() => {
      assertTargetProjectIsEmpty(targetDb, identity.projectId);
      importResult = importProjectCoreRows({
        migrationId,
        sourceDb: sourceSnapshot.db,
        targetDb,
        sourceProjectRoot: projectRoot,
        sourceDbPath,
        targetGroveId: grove.id,
        targetProjectId: identity.projectId,
        targetMachineId,
      });
      validation = validateImportedProject({
        db: targetDb,
        migrationId,
        projectId: identity.projectId,
        importResult,
      });

      if (input.dryRun) throw new DryRunRollback();

      saveProjectManifest(projectVaultDir, identity.manifest);
      registerProjectInGrove(grove.id, {
        projectId: identity.projectId,
        projectName: identity.projectName,
        projectRoot,
        bindingId: identity.bindingId,
      }, mycoHome);
      teamSyncDisabled = disableLegacyTeamSync(projectVaultDir);
      writeActivationMarker(markerPath, {
        status: 'activated',
        migration_id: migrationId,
        project_root: projectRoot,
        project_id: identity.projectId,
        project_name: identity.projectName,
        grove_id: grove.id,
        grove_slug: grove.slug,
        grove_binding_id: identity.bindingId,
        source_db_path: sourceDbPath,
        target_db_path: targetDbInfo.dbPath,
        activated_at: new Date().toISOString(),
        import_result: importResult,
        validation,
        team_sync_disabled: teamSyncDisabled,
        runtime_command_preserved: fs.existsSync(path.join(projectVaultDir, 'runtime.command')),
      });
    })();
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  } finally {
    sourceSnapshot.db.close();
    sourceSnapshot.cleanup();
    targetDb.close();
  }

  if (!importResult || !validation) {
    throw new Error('Migration activation did not produce an import result');
  }

  return {
    migration_id: migrationId,
    dry_run: Boolean(input.dryRun),
    already_activated: false,
    project_root: projectRoot,
    project_vault_dir: projectVaultDir,
    source_db_path: sourceDbPath,
    target_db_path: targetDbInfo.dbPath,
    grove,
    project_id: identity.projectId,
    project_name: identity.projectName,
    grove_binding_id: identity.bindingId,
    import_result: importResult,
    validation,
    team_sync_disabled: teamSyncDisabled,
    marker_path: markerPath,
  };
}

function openMigratedSourceSnapshot(sourceDbPath: string, machineId: string): SourceSnapshot {
  const sourceDb = openReadonly(sourceDbPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-grove-source-'));
  const snapshotPath = path.join(tempDir, 'source.db');
  let snapshotDb: Database | null = null;

  try {
    fs.writeFileSync(snapshotPath, sourceDb.serialize());
    sourceDb.close();
    snapshotDb = openDatabase(snapshotPath);
    createSchema(snapshotDb, machineId);
    return {
      db: snapshotDb,
      cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
    };
  } catch (error) {
    try {
      sourceDb.close();
    } catch {
      // ignore close errors while surfacing the original failure
    }
    snapshotDb?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function prepareIdentity(input: {
  existingManifest: ProjectManifest | null;
  grove: GroveRecord;
  projectRoot: string;
  projectName?: string;
  mycoHome: string;
}): PreparedIdentity {
  const projectId = input.existingManifest?.project.id ?? createProjectId();
  const projectName = input.existingManifest?.project.name ?? input.projectName ?? path.basename(input.projectRoot);
  const bindingId = input.existingManifest?.grove?.binding_id ?? createGroveBindingId();

  const registeredBinding = findRegisteredProjectByBinding(bindingId, input.mycoHome);
  if (registeredBinding) {
    if (registeredBinding.grove.id !== input.grove.id) {
      throw new Error(
        `Existing project.toml Grove binding ${bindingId} belongs to Grove ${registeredBinding.grove.name} (${registeredBinding.grove.slug}); refusing migration into Grove ${input.grove.name} (${input.grove.slug}).`,
      );
    }
    if (registeredBinding.project.project_id !== projectId) {
      throw new Error(
        `Existing project.toml Grove binding ${bindingId} is registered to project ${registeredBinding.project.project_id}, not ${projectId}.`,
      );
    }
    if (path.resolve(registeredBinding.project.root) !== input.projectRoot) {
      throw new Error(
        `Existing project.toml Grove binding ${bindingId} is already registered at ${registeredBinding.project.root}; refusing to rebind it to ${input.projectRoot}.`,
      );
    }
  }

  const registeredProject = findRegisteredProject({
    projectId,
    projectRoot: input.projectRoot,
  }, input.mycoHome);
  if (registeredProject && registeredProject.grove.id !== input.grove.id) {
    throw new Error(
      `Project ${projectId} is already registered in Grove ${registeredProject.grove.name} (${registeredProject.grove.slug}); refusing migration into Grove ${input.grove.name} (${input.grove.slug}).`,
    );
  }

  const manifestSlug = input.existingManifest?.grove?.slug;
  if (manifestSlug && manifestSlug !== input.grove.slug) {
    throw new Error(
      `Existing project.toml targets Grove ${manifestSlug}; refusing migration into Grove ${input.grove.slug}.`,
    );
  }

  return {
    projectId,
    projectName,
    bindingId,
    manifest: {
      ...input.existingManifest,
      project: {
        ...(input.existingManifest?.project ?? {}),
        id: projectId,
        name: projectName,
      },
      grove: {
        ...(input.existingManifest?.grove ?? {}),
        binding_id: bindingId,
        slug: input.grove.slug,
        mode: 'local',
      },
    },
  };
}

function assertTargetProjectIsEmpty(db: Database, projectId: string): void {
  const occupied = PROJECT_SCOPED_RESULT_TABLES
    .map(([, table]) => ({ table, count: countProjectRows(db, table, projectId) }))
    .filter((entry) => entry.count > 0);
  if (occupied.length === 0) return;
  const detail = occupied.map((entry) => `${entry.table}=${entry.count}`).join(', ');
  throw new Error(`Target project ${projectId} already has Grove rows without an activation marker: ${detail}`);
}

function validateImportedProject(input: {
  db: Database;
  migrationId: string;
  projectId: string;
  importResult: ImportProjectCoreResult;
}): ActivationValidationSummary {
  const targetCounts: Record<string, number> = {};
  for (const [resultKey, table] of PROJECT_SCOPED_RESULT_TABLES) {
    const expected = Number(input.importResult[resultKey] ?? 0);
    const actual = countProjectRows(input.db, table, input.projectId);
    targetCounts[table] = actual;
    if (actual < expected) {
      throw new Error(`Imported ${table} count ${actual} is lower than expected ${expected}`);
    }
  }

  const mappings = listImportMappingsForMigration(input.migrationId, input.db);
  const journalErrors = mappings.filter((row) => row.status === 'error').length;
  if (journalErrors > 0) {
    throw new Error(`Migration journal contains ${journalErrors} error mapping(s)`);
  }

  const embeddedRowsPending: Record<string, number> = {};
  for (const table of EMBEDDABLE_PROJECT_TABLES) {
    const count = countEmbeddedRows(input.db, table, input.projectId);
    embeddedRowsPending[table] = count;
    if (count > 0) {
      throw new Error(`Imported ${table} has ${count} embedded row(s); vectors must be rebuilt from unembedded rows`);
    }
  }

  const integrityCheck = readIntegrityCheck(input.db);
  if (integrityCheck !== 'ok') throw new Error(`Target Grove DB integrity check failed: ${integrityCheck}`);

  return {
    target_counts: targetCounts,
    journal_mappings: mappings.length,
    journal_errors: journalErrors,
    embedded_rows_pending: embeddedRowsPending,
    integrity_check: integrityCheck,
  };
}

function countProjectRows(db: Database, table: string, projectId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(projectId) as { count: number };
  return row.count;
}

function countEmbeddedRows(db: Database, table: string, projectId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ? AND COALESCE(embedded, 0) <> 0`,
  ).get(projectId) as { count: number };
  return row.count;
}

function readIntegrityCheck(db: Database): string {
  const row = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : null;
  return typeof value === 'string' ? value : String(value ?? '');
}

function disableLegacyTeamSync(projectVaultDir: string): boolean {
  if (!fs.existsSync(path.join(projectVaultDir, 'myco.yaml'))) return false;
  const config = loadConfig(projectVaultDir);
  if (!config.team.enabled) return false;
  updateTeamConfig(projectVaultDir, { enabled: false });
  return true;
}

function readActivationMarker(filePath: string): ActivationMarker | null {
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<ActivationMarker>;
  if (parsed.status !== 'activated') {
    throw new Error(`Unsupported Grove activation marker status in ${filePath}`);
  }
  return parsed as ActivationMarker;
}

function assertExistingMarkerMatches(marker: ActivationMarker, expected: {
  projectRoot: string;
  sourceDbPath: string;
  groveId: string;
  projectId: string;
}): void {
  const mismatches: string[] = [];
  if (path.resolve(marker.project_root) !== expected.projectRoot) mismatches.push('project root');
  if (path.resolve(marker.source_db_path) !== expected.sourceDbPath) mismatches.push('source DB path');
  if (marker.grove_id !== expected.groveId) mismatches.push('Grove id');
  if (marker.project_id !== expected.projectId) mismatches.push('project id');
  if (mismatches.length > 0) {
    throw new Error(`Existing Grove activation marker does not match requested migration: ${mismatches.join(', ')}`);
  }
}

function writeActivationMarker(filePath: string, marker: ActivationMarker): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');
}
