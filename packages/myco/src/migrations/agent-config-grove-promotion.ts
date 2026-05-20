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

import type { GroveConfig } from '../config/schema.js';

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
