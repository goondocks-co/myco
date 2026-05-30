import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadProjectManifest,
  type ProjectManifest,
} from '@myco/config/project-manifest.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { openDatabase, openReadonly, SQLITE_DB_FILE, vaultDbPath, type Database } from '@myco/db/client.js';
import {
  listImportMappingsForMigration,
  deleteImportMappingsForMigration,
} from '@myco/db/queries/migration-import-journal.js';
import { createSchema } from '@myco/db/schema.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { getMachineId } from '@myco/daemon/machine-id.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { importProjectCoreRows, type ImportProjectCoreResult } from '@myco/grove/importer.js';
import { createGroveBindingId, createGroveId, createMigrationId, createProjectId } from '@myco/grove/ids.js';
import {
  GROVE_VECTORS_FILENAME,
  pathsEquivalent,
  resolveProjectVaultDir,
  resolveMycoHome,
} from '@myco/grove/paths.js';
import {
  ensureGroveExistsLocally,
  findRegisteredProject,
  findRegisteredProjectByBinding,
  loadGroveRecord,
  registerProjectInGrove,
  resolveGrove,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { slugifyGroveName } from '@myco/grove/ids.js';

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

/**
 * Sum the imported row counts in an activation result, ignoring the
 * `skipped_*` keys that record what wasn't migrated.
 */
export function summarizeImportedRowCount(result: ImportProjectCoreResult | null): number {
  if (!result) return 0;
  return Object.entries(result)
    .filter(([key]) => !key.startsWith('skipped_'))
    .reduce((sum, [, value]) => sum + Number(value), 0);
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
  marker_path: string;
}

export interface ActivationMarker {
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
  legacy_archived?: { archived_at: string; archive_dir: string };
  legacy_archive_error?: { failed_at: string; message: string };
}

/**
 * Files and directories under `.myco/` that hold legacy data superseded
 * by the Grove DB. After successful activation these are moved into
 * `.myco/.archive-<timestamp>/` so the directory stops looking like an
 * active vault while remaining recoverable.
 *
 * Files intentionally **kept** at the top of `.myco/` after activation:
 *
 * * `project.toml` — committed project identity
 * * `myco.yaml`, `local.yaml` — committed and per-machine config
 * * `tasks/` — committed project-authored task overrides
 * * `buffer/` — fallback hook buffer used when the daemon is offline
 * * `migration/` — activation marker / per-project migration state
 * * `secrets.env`, `machine_id`, `last-update-version`, `.gitignore`
 *
 * Anything not in this list above and not in `LEGACY_ARCHIVE_ENTRIES`
 * is left in place — opt-in archival, not opt-out, so a future
 * project-authored file isn't silently moved.
 */
const LEGACY_ARCHIVE_ENTRIES: readonly string[] = [
  SQLITE_DB_FILE,
  `${SQLITE_DB_FILE}-shm`,
  `${SQLITE_DB_FILE}-wal`,
  GROVE_VECTORS_FILENAME,
  `${GROVE_VECTORS_FILENAME}-shm`,
  `${GROVE_VECTORS_FILENAME}-wal`,
  'staging',
  'logs',
  'team',
  'attachments',
];

interface PreparedIdentity {
  projectId: string;
  projectName: string;
  bindingId: string;
  manifest: ProjectManifest;
  localManifest: { grove_binding: { binding_id: string; mode: 'local' } };
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
  const sourceDbPath = vaultDbPath(projectVaultDir);

  const mycoHome = input.mycoHome ?? resolveMycoHome();
  const earlyManifest = loadProjectManifest(projectVaultDir);
  const earlyMarker = readActivationMarker(activationMarkerPath(projectVaultDir));
  const grove = resolveActivationGrove({
    groveRef: input.groveRef,
    existingManifest: earlyManifest,
    existingMarker: earlyMarker,
    projectRoot,
    mycoHome,
  });
  const markerPath = activationMarkerPath(projectVaultDir);
  // Once activation has run, the legacy DB is moved into `.archive-…/`
  // by the post-import sweep — so the source-DB existence check only
  // applies to a true first-run activation. Reading the marker first
  // keeps re-runs idempotent after the archive step lands.
  const existingMarkerEarly = earlyMarker;
  if (!existingMarkerEarly && !fs.existsSync(sourceDbPath)) {
    throw new Error(`Legacy project database not found: ${sourceDbPath}`);
  }

  const existingManifest = earlyManifest;
  const identity = prepareIdentity({
    existingManifest,
    existingMarker: existingMarkerEarly,
    grove,
    projectRoot,
    projectName: input.projectName,
    mycoHome,
  });
  const targetDbInfo = ensureGroveDatabase(grove.id, mycoHome);
  const existingMarker = existingMarkerEarly;
  if (existingMarker) {
    assertExistingMarkerMatches(existingMarker, {
      projectRoot,
      sourceDbPath,
      groveId: grove.id,
      projectId: identity.projectId,
    });
    // Repair the triple invariant before returning. The marker is
    // authoritative — it was the last thing the activation transaction
    // wrote — so if `project.toml` or the registry row went missing
    // (manual delete, partial restore, errant cleanup), regenerate them
    // from the marker rather than silently letting the daemon fall back
    // to legacy mode and create a divergent database.
    if (!input.dryRun) {
      // Repair re-entry: re-attach the marker-anchored identity through
      // ProjectVault so manifest + binding + gitignore stay in lockstep.
      //
      // Three sub-cases match the old activation contract exactly:
      //   1. No manifest on disk → write both files
      //   2. Manifest present, binding missing → write ONLY the local
      //      manifest. The on-disk manifest may carry user edits the
      //      marker doesn't know about; preserve it.
      //   3. Manifest + binding both present → no writes; just refresh
      //      the gitignore.
      const vault = new ProjectVault(projectRoot);
      if (!existingManifest) {
        vault.writeIdentity({
          manifest: identity.manifest,
          localManifest: identity.localManifest,
        });
      } else if (!existingManifest.grove?.binding_id) {
        vault.writeIdentity({
          manifest: identity.manifest,
          localManifest: identity.localManifest,
          mode: 'local-only',
        });
      } else {
        vault.ensureGitignore();
      }
      const registered = findRegisteredProject({
        projectId: existingMarker.project_id,
        bindingId: existingMarker.grove_binding_id,
        groveId: existingMarker.grove_id,
      }, mycoHome);
      if (!registered) {
        registerProjectInGrove(existingMarker.grove_id, {
          projectId: existingMarker.project_id,
          projectName: existingMarker.project_name,
          projectRoot,
          bindingId: existingMarker.grove_binding_id,
        }, mycoHome);
      }
    }
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
      marker_path: markerPath,
    };
  }

  const migrationId = input.migrationId ?? createMigrationId();
  const targetMachineId = input.targetMachineId ?? getMachineId();
  const sourceSnapshot = openMigratedSourceSnapshot(sourceDbPath, targetMachineId);
  const targetDb = openDatabase(targetDbInfo.dbPath);
  let importResult: ImportProjectCoreResult | null = null;
  let validation: ActivationValidationSummary | null = null;

  try {
    // Use the resolved target machine id so the v52 conversion runs; the
    // 'local' default would skip the machine_id='local'→real backfill.
    createSchema(targetDb, targetMachineId);
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

      // Drop the migration journal — it's mid-import working state
      // (FK lookups + status checks during validation) and nothing
      // reads it post-marker. Cleanup runs inside the same
      // transaction as the import so it commits atomically.
      deleteImportMappingsForMigration(migrationId, targetDb);
    })();

    // FS side effects run only after the DB transaction has committed.
    // If anything inside the transaction throws — import error,
    // validation failure, journal cleanup, or COMMIT itself — SQLite
    // rolls back AND the marker file never lands. Re-runs see a clean
    // target DB and no marker, so they retry the full import instead
    // of false-success-shortcutting on a poisoned marker.
    //
    // Within the FS phase, marker is written LAST: manifest +
    // registry writes are idempotent (re-running activation overwrites
    // them with the same values), so a failure between them and the
    // marker write leaves the next run able to recover. A failure
    // BEFORE the marker write means the next run repeats those FS
    // writes and tries again from a still-empty Grove DB.
    if (!input.dryRun) {
      // Atomic identity write via ProjectVault: gitignore refresh +
      // project.toml + project.local.toml in lockstep, so the per-
      // machine binding cannot leak to git regardless of which file
      // hits disk first. writeIdentity is the single sanctioned path
      // for grove activation, move, claim, and binding repairs.
      new ProjectVault(projectRoot).writeIdentity({
        manifest: identity.manifest,
        localManifest: identity.localManifest,
      });
      registerProjectInGrove(grove.id, {
        projectId: identity.projectId,
        projectName: identity.projectName,
        projectRoot,
        bindingId: identity.bindingId,
      }, mycoHome);
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
        import_result: importResult!,
        validation: validation!,
      });

      // Archive legacy vault data on success. Done outside the DB
      // transaction because it touches the filesystem; the marker has
      // already been written, so any failure here is recoverable via
      // `completeLegacyArchive`.
      stampLegacyArchiveOnMarker(projectVaultDir, markerPath);
    }
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
    marker_path: markerPath,
  };
}

function resolveActivationGrove(input: {
  groveRef: string | undefined;
  existingManifest: ProjectManifest | null;
  existingMarker: ActivationMarker | null;
  projectRoot: string;
  mycoHome: string;
}): GroveRecord {
  if (input.groveRef) return resolveGrove(input.groveRef, input.mycoHome);

  const manifestGroveId = input.existingManifest?.grove?.id;
  const markerGroveId = input.existingMarker?.grove_id;
  const candidateId = manifestGroveId ?? markerGroveId;
  if (candidateId) {
    const local = loadGroveRecord(candidateId, input.mycoHome);
    if (local) return local;
    const fallbackName = input.existingManifest?.grove?.name
      ?? input.existingManifest?.project.name
      ?? path.basename(input.projectRoot);
    const fallbackSlug = input.existingManifest?.grove?.slug
      ?? slugifyGroveName(fallbackName);
    return ensureGroveExistsLocally(
      candidateId,
      { name: fallbackName, slug: fallbackSlug },
      input.mycoHome,
    );
  }

  return resolveGrove(undefined, input.mycoHome);
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
  existingMarker: ActivationMarker | null;
  grove: GroveRecord;
  projectRoot: string;
  projectName?: string;
  mycoHome: string;
}): PreparedIdentity {
  // Identity preference: manifest first (if present), marker second (when
  // we're repairing a vault whose project.toml went missing post-migration),
  // freshly-minted last (true first-run activation). This keeps repair
  // runs aligned with the existing marker so `assertExistingMarkerMatches`
  // doesn't throw on a brand-new id we just minted.
  const projectId = input.existingManifest?.project.id
    ?? input.existingMarker?.project_id
    ?? createProjectId();
  const projectName = input.existingManifest?.project.name
    ?? input.existingMarker?.project_name
    ?? input.projectName
    ?? path.basename(input.projectRoot);
  const bindingId = input.existingManifest?.grove?.binding_id
    ?? input.existingMarker?.grove_binding_id
    ?? createGroveBindingId();

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
    if (!pathsEquivalent(registeredBinding.project.root, input.projectRoot)) {
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
  const manifestGroveId = input.existingManifest?.grove?.id;
  const slugReconciledByGroveId = manifestGroveId && manifestGroveId === input.grove.id;
  if (manifestSlug && !slugReconciledByGroveId && manifestSlug !== input.grove.slug) {
    throw new Error(
      `Existing project.toml targets Grove ${manifestSlug}; refusing migration into Grove ${input.grove.slug}.`,
    );
  }

  const existingGrove = input.existingManifest?.grove;
  const portableGrove: NonNullable<ProjectManifest['grove']> = {
    mode: 'local',
    id: input.grove.id,
    slug: input.grove.slug,
    name: input.grove.name,
    ...(existingGrove?.remote ? { remote: existingGrove.remote } : {}),
  };

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
      grove: portableGrove,
    },
    localManifest: {
      grove_binding: {
        binding_id: bindingId,
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

/**
 * Move post-activation legacy files into `.myco/.archive-<timestamp>/`.
 * Returns the archive directory path so the marker can record it.
 * Idempotent: if no `LEGACY_ARCHIVE_ENTRIES` are present, returns null.
 */
export function archiveLegacyVaultData(projectVaultDir: string): string | null {
  const present = LEGACY_ARCHIVE_ENTRIES.filter((name) =>
    fs.existsSync(path.join(projectVaultDir, name)),
  );
  if (present.length === 0) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(projectVaultDir, `.archive-${stamp}`);
  fs.mkdirSync(archiveDir, { recursive: true });

  for (const name of present) {
    fs.renameSync(path.join(projectVaultDir, name), path.join(archiveDir, name));
  }
  return archiveDir;
}

/**
 * Stand-alone archive completion for installs whose Grove activation ran
 * before the archive step existed. Reads the existing activation marker,
 * confirms it is `activated`, archives any leftover legacy data, and
 * stamps `legacy_archived` on the marker. Idempotent — repeated calls
 * after archive completion are no-ops.
 */
export function completeLegacyArchive(projectVaultDir: string): {
  archived_dir: string | null;
  already_complete: boolean;
} {
  const markerPath = path.join(projectVaultDir, 'migration', GROVE_ACTIVATION_MARKER);
  const marker = readActivationMarker(markerPath);
  if (!marker) return { archived_dir: null, already_complete: false };

  // Even when `legacy_archived` is already set, sweep again in case a
  // previous archive left items behind — the rename is bounded to
  // LEGACY_ARCHIVE_ENTRIES still present at the top of the vault.
  const result = stampLegacyArchiveOnMarker(projectVaultDir, markerPath);
  return {
    archived_dir: result.archived_dir,
    already_complete: Boolean(marker.legacy_archived) && result.archived_dir === null,
  };
}

function stampLegacyArchiveOnMarker(
  projectVaultDir: string,
  markerPath: string,
): { archived_dir: string | null } {
  let archivedDir: string | null = null;
  let archiveError: unknown = null;
  try {
    archivedDir = archiveLegacyVaultData(projectVaultDir);
  } catch (err) {
    archiveError = err;
  }

  const marker = readActivationMarker(markerPath);
  if (!marker) return { archived_dir: archivedDir };

  const next: ActivationMarker = { ...marker };
  if (archiveError) {
    next.legacy_archive_error = {
      failed_at: new Date().toISOString(),
      message: errorMessage(archiveError),
    };
  } else {
    delete next.legacy_archive_error;
    if (archivedDir) {
      next.legacy_archived = {
        archived_at: new Date().toISOString(),
        archive_dir: archivedDir,
      };
    }
  }
  writeActivationMarker(markerPath, next);
  return { archived_dir: archivedDir };
}

export function readActivationMarker(filePath: string): ActivationMarker | null {
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
  // pathsEquivalent handles macOS APFS case-insensitivity and symlink chains;
  // bare path.resolve compares case-sensitive strings and would falsely flag
  // `/Users/me/repos/...` vs `/Users/me/Repos/...` as a mismatch.
  if (!pathsEquivalent(marker.project_root, expected.projectRoot)) mismatches.push('project root');
  if (!pathsEquivalent(marker.source_db_path, expected.sourceDbPath)) mismatches.push('source DB path');
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
