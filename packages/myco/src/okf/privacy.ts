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

/** UUID-shaped identifiers (session/run/batch ids) — global variant of the publish-eligibility scan's detector. */
const PUBLISHED_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Replace every UUID-shaped identifier with its stable `id-hash-<16 hex>`
 * reference. Equal inputs keep equal refs across regenerations, so citations
 * remain stable link anchors without exposing the source identifier. Secrets
 * and absolute local paths are deliberately NOT rewritten here — those must
 * block publish for human inspection, not be silently masked.
 */
export function sanitizePublishedText(text: string): string {
  return text.replace(PUBLISHED_UUID_RE, (m) => `id-hash-${sha256Hex(m.toLowerCase()).slice(0, 16)}`);
}
