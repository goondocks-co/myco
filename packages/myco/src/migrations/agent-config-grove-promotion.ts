/**
 * Agent-config Grove promotion migration.
 *
 * Lifts agent.* and embedding.* fields from each project's myco.yaml to
 * the project's Grove grove.yaml, then strips those paths from every
 * project's myco.yaml and local.yaml. First-project-wins per Grove;
 * non-first projects' values are archived but discarded.
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { GroveConfigSchema, ProjectConfigSchema, type GroveConfig } from '../config/schema.js';
import { loadGroveConfig, saveGroveConfig } from '../config/loader.js';
import { resolveGroveDir, resolveMycoHome } from '../grove/paths.js';
import { getAtPath, setAtPath, unsetAtPath } from '../utils/dot-path.js';
import { isPlainObject, deepMerge } from '../utils/deep-merge.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

/** Dot-path entries promoted from Project tier to Grove tier in 2026-05. */
export const PROMOTED_PATHS: ReadonlyArray<readonly string[]> = [
  ['embedding', 'provider'],
  ['embedding', 'model'],
  ['embedding', 'base_url'],
  ['agent', 'provider'],
  ['agent', 'harness'],
  ['agent', 'model'],
  ['agent', 'tasks'],
  ['agent', 'summary_batch_interval'],
  ['agent', 'scheduled_tasks_enabled'],
  ['agent', 'event_tasks_enabled'],
  ['agent', 'cold_project_threshold_days'],
];

/** Per-project migration state during read pass. */
export interface MigrationProjectState {
  projectId: string;
  vaultDir: string;
  groveId: string;
  mycoYamlPath: string;
  localYamlPath: string;
  originalMyco: Record<string, unknown>;
  originalLocal: Record<string, unknown>;
  strippedMyco: Record<string, unknown>;
  strippedLocal: Record<string, unknown>;
  promotedSliceMyco: Record<string, unknown>;
  promotedSliceLocal: Record<string, unknown>;
  /**
   * True when `localYamlPath` existed on disk during the read pass.
   * Used by the write phase to avoid creating a new empty local.yaml
   * for projects that never had one.
   */
  originalLocalExisted: boolean;
}

/** Per-Grove migration state during read pass. */
export interface MigrationGroveState {
  groveId: string;
  grovePath: string;
  originalGroveConfig: GroveConfig;
  candidateGroveConfig: GroveConfig;
  liftedFromProjectId: string | null;
  projects: MigrationProjectState[];
}

export interface MigrationPlan {
  groves: MigrationGroveState[];
}

export interface MigrationError {
  groveId?: string;
  projectId?: string;
  filePath?: string;
  message: string;
}

export interface MigrationResult {
  ok: boolean;
  plan: MigrationPlan;
  errors: MigrationError[];
}

/** Machine-level input type for the read pass. */
export interface MachineState {
  groves: Array<{
    id: string;
    grovePath: string;
    projects: Array<{
      id: string;
      vaultDir: string;
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read a raw YAML file as a plain object. Returns `{}` when the file is
 * absent, empty, or non-mapping. Throws on parse errors (caller handles).
 */
function readRawYaml(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return {};
  const parsed = YAML.parse(raw);
  if (!isPlainObject(parsed)) return {};
  return parsed;
}

/**
 * In a single pass over `PROMOTED_PATHS`, extract the promoted-path values
 * into a slice and produce a stripped clone with those paths removed.
 * Avoids the two-pass pattern (extractPromotedSlice + stripPromotedPaths).
 */
function extractAndStrip(
  doc: Record<string, unknown>,
): { slice: Record<string, unknown>; stripped: Record<string, unknown> } {
  const slice: Record<string, unknown> = {};
  const stripped = structuredClone(doc);
  for (const segments of PROMOTED_PATHS) {
    const value = getAtPath(doc, segments);
    if (value !== undefined) {
      setAtPath(slice, segments, value);
    }
    unsetAtPath(stripped, segments, { pruneEmptyParents: true });
  }
  return { slice, stripped };
}


// ---------------------------------------------------------------------------
// readMigrationPlan
// ---------------------------------------------------------------------------

/**
 * Walk each Grove on the machine and its registered projects; build the
 * complete migration plan. Parse errors are recorded in `errors` rather
 * than aborting — the caller can inspect the plan and decide whether to
 * proceed.
 */
export async function readMigrationPlan(
  machine: MachineState,
  options: { mycoHome?: string } = {},
): Promise<{ plan: MigrationPlan; errors: MigrationError[] }> {
  const mycoHome = options.mycoHome ?? resolveMycoHome();
  const errors: MigrationError[] = [];
  const groves: MigrationGroveState[] = [];

  for (const groveInput of machine.groves) {
    const { id: groveId, grovePath, projects: projectInputs } = groveInput;

    // Load current grove config (Zod-parsed, with defaults).
    let originalGroveConfig: GroveConfig;
    try {
      originalGroveConfig = loadGroveConfig(groveId, mycoHome);
    } catch (err) {
      errors.push({
        groveId,
        message: `Failed to load grove config for ${groveId}: ${(err as Error).message}`,
      });
      continue;
    }

    const projects: MigrationProjectState[] = [];
    let liftedFromProjectId: string | null = null;
    // Start with the original grove config as the raw base for candidate merge.
    // We need the raw doc (not Zod-defaults) so we don't confuse defaults with
    // user-set values. Re-read raw YAML for the "present" check.
    const groveConfigFilePath = path.join(grovePath, 'grove.yaml');
    const groveRaw = readRawYaml(groveConfigFilePath);

    let candidateRaw = structuredClone(groveRaw);

    for (const projectInput of projectInputs) {
      const { id: projectId, vaultDir } = projectInput;
      const mycoYamlPath = path.join(vaultDir, 'myco.yaml');
      const localYamlPath = path.join(vaultDir, 'local.yaml');

      // Check local.yaml existence before reading (needed for originalLocalExisted).
      const originalLocalExisted = fs.existsSync(localYamlPath);

      // Read myco.yaml
      let originalMyco: Record<string, unknown>;
      try {
        originalMyco = readRawYaml(mycoYamlPath);
      } catch (err) {
        errors.push({
          groveId,
          projectId,
          filePath: mycoYamlPath,
          message: `Failed to parse myco.yaml for project ${projectId}: ${(err as Error).message}`,
        });
        // Still push a project state with empty docs so the plan is complete.
        projects.push({
          projectId,
          vaultDir,
          groveId,
          mycoYamlPath,
          localYamlPath,
          originalMyco: {},
          originalLocal: {},
          strippedMyco: {},
          strippedLocal: {},
          promotedSliceMyco: {},
          promotedSliceLocal: {},
          originalLocalExisted,
        });
        continue;
      }

      // Read local.yaml (failures here are non-fatal; treat as {}).
      let originalLocal: Record<string, unknown>;
      try {
        originalLocal = readRawYaml(localYamlPath);
      } catch (err) {
        errors.push({
          groveId,
          projectId,
          filePath: localYamlPath,
          message: `Failed to parse local.yaml for project ${projectId}: ${(err as Error).message}`,
        });
        originalLocal = {};
      }

      const { slice: promotedSliceMyco, stripped: strippedMyco } = extractAndStrip(originalMyco);
      const { slice: promotedSliceLocal, stripped: strippedLocal } = extractAndStrip(originalLocal);

      // First project with any promoted values lifts into the Grove config.
      if (liftedFromProjectId === null && Object.keys(promotedSliceMyco).length > 0) {
        liftedFromProjectId = projectId;
        // Grove-existing wins: merge with candidateRaw as source so its values
        // overwrite any keys already present in candidateRaw at conflict points.
        candidateRaw = deepMerge(promotedSliceMyco, candidateRaw, { arrayStrategy: 'replace' }) as Record<string, unknown>;
      }

      projects.push({
        projectId,
        vaultDir,
        groveId,
        mycoYamlPath,
        localYamlPath,
        originalMyco,
        originalLocal,
        strippedMyco,
        strippedLocal,
        promotedSliceMyco,
        promotedSliceLocal,
        originalLocalExisted,
      });
    }

    // Parse the candidate raw doc through GroveConfigSchema to fill defaults.
    // If parsing fails, record an error but keep the original as candidate.
    let candidateGroveConfig: GroveConfig;
    try {
      candidateGroveConfig = GroveConfigSchema.parse(candidateRaw);
    } catch {
      // Fall back to original; the validation pass will surface the error.
      candidateGroveConfig = originalGroveConfig;
    }

    groves.push({
      groveId,
      grovePath,
      originalGroveConfig,
      candidateGroveConfig,
      liftedFromProjectId,
      projects,
    });
  }

  return { plan: { groves }, errors };
}

// ---------------------------------------------------------------------------
// validateMigrationPlan
// ---------------------------------------------------------------------------

/**
 * Validate the migration plan produced by `readMigrationPlan`:
 *   1. Each candidate Grove config must parse cleanly through GroveConfigSchema.
 *   2. Each strippedMyco must parse through ProjectConfigSchema.
 *   3. No PROMOTED_PATHS may remain in strippedLocal.
 *
 * Returns `{ ok, plan, errors }`. When `ok` is false, `errors` describes
 * every problem found.
 */
export function validateMigrationPlan(plan: MigrationPlan): MigrationResult {
  const errors: MigrationError[] = [];

  for (const grove of plan.groves) {
    // 1. Validate candidate Grove config.
    const groveResult = GroveConfigSchema.safeParse(grove.candidateGroveConfig);
    if (!groveResult.success) {
      errors.push({
        groveId: grove.groveId,
        filePath: path.join(grove.grovePath, 'grove.yaml'),
        message: `Candidate grove config for ${grove.groveId} failed validation: ${groveResult.error.message}`,
      });
    }

    for (const project of grove.projects) {
      // 2. Validate stripped myco.yaml shape through ProjectConfigSchema.
      const projectResult = ProjectConfigSchema.safeParse(project.strippedMyco);
      if (!projectResult.success) {
        errors.push({
          groveId: grove.groveId,
          projectId: project.projectId,
          filePath: project.mycoYamlPath,
          message: `Stripped myco.yaml for project ${project.projectId} failed validation: ${projectResult.error.message}`,
        });
      }

      // 3. Assert no promoted path remains in strippedLocal.
      for (const segments of PROMOTED_PATHS) {
        const value = getAtPath(project.strippedLocal, segments);
        if (value !== undefined) {
          errors.push({
            groveId: grove.groveId,
            projectId: project.projectId,
            filePath: project.localYamlPath,
            message: `Promoted path "${segments.join('.')}" still present in strippedLocal for project ${project.projectId}`,
          });
        }
      }
    }
  }

  return { ok: errors.length === 0, plan, errors };
}

// ---------------------------------------------------------------------------
// writeArchive
// ---------------------------------------------------------------------------

/**
 * Capture the original promoted-field values from a project to a timestamped
 * archive directory before stripping them.
 *
 * Returns the archive file path, or null when both slices are empty (nothing
 * to archive).
 */
export function writeArchive(project: MigrationProjectState): string | null {
  const mycoEmpty = Object.keys(project.promotedSliceMyco).length === 0;
  const localEmpty = Object.keys(project.promotedSliceLocal).length === 0;
  if (mycoEmpty && localEmpty) return null;

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const archiveDir = path.join(project.vaultDir, `.archive-agent-config-${timestamp}`);
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, 'agent-config-promotion.yaml');

  const document = {
    project_id: project.projectId,
    grove_id: project.groveId,
    captured_at: now.toISOString(),
    myco_yaml: project.promotedSliceMyco,
    local_yaml: project.promotedSliceLocal,
  };
  fs.writeFileSync(archivePath, YAML.stringify(document), 'utf-8');
  return archivePath;
}

// ---------------------------------------------------------------------------
// executeMigration
// ---------------------------------------------------------------------------

/**
 * Atomic per-Grove write phase: writes candidate Grove config, archives
 * promoted project values, then writes stripped myco.yaml + local.yaml.
 *
 * Errors are collected rather than thrown — a Grove-level failure short-
 * circuits that Grove's project writes but does not abort other Groves.
 */
export async function executeMigration(
  plan: MigrationPlan,
  options: { mycoHome?: string } = {},
): Promise<MigrationResult> {
  const mycoHome = options.mycoHome ?? resolveMycoHome();
  const errors: MigrationError[] = [];

  for (const grove of plan.groves) {
    // Only write the Grove config when the candidate differs from the original
    // (avoids a no-op write and unnecessary cache invalidation).
    const changed =
      JSON.stringify(grove.candidateGroveConfig) !== JSON.stringify(grove.originalGroveConfig);
    if (changed) {
      try {
        saveGroveConfig(grove.groveId, grove.candidateGroveConfig, mycoHome);
      } catch (err) {
        errors.push({
          groveId: grove.groveId,
          message: `grove write failed: ${String(err)}`,
        });
        continue;
      }
    }

    for (const project of grove.projects) {
      try {
        writeArchive(project);
      } catch (err) {
        errors.push({
          groveId: grove.groveId,
          projectId: project.projectId,
          message: `archive write failed: ${String(err)}`,
        });
        continue;
      }

      try {
        atomicWriteFileSync(project.mycoYamlPath, YAML.stringify(project.strippedMyco));

        // Only write local.yaml when the file previously existed, OR when
        // strippedLocal has content. This avoids creating a new empty
        // local.yaml for projects that never had one.
        const localHasContent = Object.keys(project.strippedLocal).length > 0;
        if (project.originalLocalExisted || localHasContent) {
          atomicWriteFileSync(project.localYamlPath, YAML.stringify(project.strippedLocal));
        }
      } catch (err) {
        errors.push({
          groveId: grove.groveId,
          projectId: project.projectId,
          message: `project file write failed: ${String(err)}`,
        });
      }
    }
  }

  return { ok: errors.length === 0, plan, errors };
}

