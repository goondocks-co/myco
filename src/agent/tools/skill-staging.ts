/**
 * Staging filesystem for provisional skill writes.
 *
 * Keyed by candidate id so draft-phase re-runs overwrite cleanly and
 * executor-level cleanup can find the staged content without tracking
 * additional per-run state.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Absolute path to the staging root directory within a vault. */
export function stagingRoot(vaultDir: string): string {
  return resolve(vaultDir, 'staging', 'skills');
}

/** Absolute path to the staged SKILL.md for a given candidate id. */
export function stagingPath(vaultDir: string, candidateId: string): string {
  return join(stagingRoot(vaultDir), candidateId, 'SKILL.md');
}

/** Absolute path to the staged manifest.json for a given candidate id. */
export function stagingManifestPath(vaultDir: string, candidateId: string): string {
  return join(stagingRoot(vaultDir), candidateId, 'manifest.json');
}

// ---------------------------------------------------------------------------
// Manifest shape
// ---------------------------------------------------------------------------

/**
 * Metadata the stage tool persists alongside SKILL.md so the finalize tool
 * can promote the skill without the agent having to repeat the same fields.
 * Structured JSON; shape is stable across stage/finalize calls.
 */
export interface StagedManifest {
  candidate_id: string;
  name: string;
  display_name: string;
  description: string;
  /** JSON-encoded array of source IDs (session/spore/entity). */
  source_ids: string;
  /** Human-readable rationale for lineage. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Write `content` to the staging path for `candidateId`. Creates
 * intermediate directories. Returns the absolute path of the written file.
 *
 * Overwrites any existing staged content — the draft phase may call this
 * multiple times during iterative rewrites before the validate phase.
 */
export function writeStagedSkill(
  vaultDir: string,
  candidateId: string,
  content: string,
): string {
  const path = stagingPath(vaultDir, candidateId);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return path;
}

/** Read the staged SKILL.md for a candidate. Returns `null` if not staged. */
export function readStagedSkill(vaultDir: string, candidateId: string): string | null {
  const path = stagingPath(vaultDir, candidateId);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

/**
 * Write the staged manifest for a candidate. Creates intermediate
 * directories. The manifest is read back by vault_finalize_skill so the
 * finalize call only needs the candidate_id to know what to promote.
 */
export function writeStagedManifest(
  vaultDir: string,
  candidateId: string,
  manifest: StagedManifest,
): string {
  const path = stagingManifestPath(vaultDir, candidateId);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf-8');
  return path;
}

/** Read the staged manifest for a candidate. Returns `null` if not staged. */
export function readStagedManifest(
  vaultDir: string,
  candidateId: string,
): StagedManifest | null {
  const path = stagingManifestPath(vaultDir, candidateId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as StagedManifest;
  } catch {
    // Corrupt manifest — treat as unstaged so the caller can rewrite
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Remove the staging directory for a candidate. Idempotent — safe to call
 * on entries that don't exist, or to call multiple times.
 */
export function cleanupStagedSkill(vaultDir: string, candidateId: string): void {
  const dir = resolve(stagingRoot(vaultDir), candidateId);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort — cleanup never blocks callers */
  }
}

/**
 * Return candidate IDs whose staging directories are older than
 * `maxAgeMs`. Used by the daemon periodic sweep to GC abandoned entries
 * from runs that crashed before either the finalize or executor-level
 * cleanup could fire.
 *
 * Returns directory names only (not full paths) so callers can pass
 * them directly to `cleanupStagedSkill`.
 */
export function listStaleStagingDirs(vaultDir: string, maxAgeMs: number): string[] {
  const root = stagingRoot(vaultDir);
  if (!existsSync(root)) return [];

  const cutoff = Date.now() - maxAgeMs;
  const stale: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(root, entry.name);
    try {
      const st = statSync(dirPath);
      if (st.mtimeMs < cutoff) {
        stale.push(entry.name);
      }
    } catch {
      /* stat failed — skip entry, GC will retry next cycle */
    }
  }

  return stale;
}
