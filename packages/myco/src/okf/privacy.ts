import { sha256Hex } from '@myco/canopy/hash.js';

/**
 * Identifier hashing for published bundles.
 *
 * Published bundles must never emit `machine_id`, `session_id`,
 * `prompt_batch_id`, raw run IDs, raw project IDs, or absolute local paths.
 * Stable references that survive publication are derived by hashing, so equal
 * inputs keep equal refs across regenerations without exposing the source
 * identifier.
 */

/** Stable, non-reversible project reference for published frontmatter. */
export function mycoProjectRef(projectId: string): string {
  return `project-hash-${sha256Hex(projectId).slice(0, 16)}`;
}

/** Stable, non-reversible run reference; undefined when there is no run. */
export function runRef(runId: string | null | undefined): string | undefined {
  if (!runId) return undefined;
  return `run-hash-${sha256Hex(runId).slice(0, 16)}`;
}
