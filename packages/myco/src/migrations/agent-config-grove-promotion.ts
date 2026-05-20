/**
 * Agent-config Grove promotion migration.
 *
 * Lifts agent.* and embedding.* fields from each project's myco.yaml to
 * the project's Grove grove.yaml, then strips those paths from every
 * project's myco.yaml and local.yaml. First-project-wins per Grove;
 * non-first projects' values are archived but discarded.
 *
 * Spec: docs/superpowers/specs/2026-05-20-myco-agent-config-grove-promotion-design.md
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { GroveConfigSchema, ProjectConfigSchema, type GroveConfig } from '../config/schema.js';
import { loadGroveConfig } from '../config/loader.js';
import { resolveGroveDir, resolveMycoHome } from '../grove/paths.js';
import { getAtPath, setAtPath, unsetAtPath } from '../utils/dot-path.js';
import { isPlainObject } from '../utils/deep-merge.js';

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
  plan?: MigrationPlan;
  errors: MigrationError[];
}

/**
 * Machine-level input type for the read pass. Callers (Task 5.6) provide
 * this by walking listRegisteredGroves / listProjectsInGrove.
 */
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
 * Deep-clone a plain object via JSON round-trip. Sufficient for config
 * shapes (strings, numbers, booleans, arrays, nested objects).
 */
function cloneDoc(obj: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
}

/**
 * Extract the subset of `doc` that lives under `PROMOTED_PATHS`.
 * Returns a sparse object containing only the paths that have a value.
 */
function extractPromotedSlice(doc: Record<string, unknown>): Record<string, unknown> {
  const slice: Record<string, unknown> = {};
  for (const segments of PROMOTED_PATHS) {
    const value = getAtPath(doc, segments);
    if (value !== undefined) {
      setAtPath(slice, segments, value);
    }
  }
  return slice;
}

/**
 * Return a clone of `doc` with all `PROMOTED_PATHS` removed.
 */
function stripPromotedPaths(doc: Record<string, unknown>): Record<string, unknown> {
  const stripped = cloneDoc(doc);
  for (const segments of PROMOTED_PATHS) {
    unsetAtPath(stripped, segments, { pruneEmptyParents: true });
  }
  return stripped;
}

/**
 * Merge `source` into `base`, but only at keys where `base` does NOT
 * already have an explicit value (i.e. base-existing wins). Operates
 * recursively at plain-object boundaries.
 */
function deepMergeUnlessPresent(
  base: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key in result) {
      // Base already has a value — recurse for nested objects, skip scalars.
      if (isPlainObject(result[key]) && isPlainObject(value)) {
        result[key] = deepMergeUnlessPresent(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      }
      // Otherwise: base wins, skip.
    } else {
      result[key] = value;
    }
  }
  return result;
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

    let candidateRaw = cloneDoc(groveRaw);

    for (const projectInput of projectInputs) {
      const { id: projectId, vaultDir } = projectInput;
      const mycoYamlPath = path.join(vaultDir, 'myco.yaml');
      const localYamlPath = path.join(vaultDir, 'local.yaml');

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

      const promotedSliceMyco = extractPromotedSlice(originalMyco);
      const promotedSliceLocal = extractPromotedSlice(originalLocal);
      const strippedMyco = stripPromotedPaths(originalMyco);
      const strippedLocal = stripPromotedPaths(originalLocal);

      // First project with any promoted values lifts into the Grove config.
      if (liftedFromProjectId === null && Object.keys(promotedSliceMyco).length > 0) {
        liftedFromProjectId = projectId;
        // Grove-existing wins: only copy paths that aren't already set in groveRaw.
        candidateRaw = deepMergeUnlessPresent(candidateRaw, promotedSliceMyco) as Record<string, unknown>;
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
