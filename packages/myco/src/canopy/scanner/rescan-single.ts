import fs from 'node:fs';
import path from 'node:path';
import { scanFile } from './scan-file.js';
import { upsertCanopyEntry, deleteCanopyEntry } from './upsert.js';
import { createLayeredExcludeMatcher } from '../exclude.js';
import { epochSeconds } from '@myco/constants.js';
import type { Database } from 'bun:sqlite';

export interface RescanSingleOptions {
  db: Database;
  projectId: string;
  machineId: string;
  projectRoot: string;
  /** Repo-relative or absolute path; absolute is normalised against projectRoot. */
  filePath: string;
  /** Optional `canopy.exclude.patterns` list; falls back to none. */
  excludePatterns?: string[];
  maxBytes?: number;
}

export type RescanSingleResult =
  | { ok: true; action: 'upserted' | 'deleted'; relPath: string }
  | { ok: false; reason: 'outside_project' | 'skipped' | 'excluded'; relPath: string };

/**
 * Re-scan a single file in response to a Write/Edit/Delete tool event.
 * Cheap and idempotent — one stat, at most one read, one upsert. The path
 * is normalised against the project root so absolute paths from tool inputs
 * resolve identically to relative ones, and paths outside the project are
 * rejected so we never index files we don't own.
 */
export function rescanSingle(opts: RescanSingleOptions): RescanSingleResult {
  const rel = relativise(opts.projectRoot, opts.filePath);
  if (rel === null) return { ok: false, reason: 'outside_project', relPath: opts.filePath };

  // Apply the same layered exclude matcher used by full/delta scans so a
  // tool-use event for a gitignored or managed path doesn't sneak a row
  // into canopy_entries that the next full scan would just tombstone.
  const isExcluded = createLayeredExcludeMatcher({
    projectRoot: opts.projectRoot,
    userPatterns: opts.excludePatterns ?? [],
  });
  if (isExcluded(rel, false)) {
    // If a stale row exists for this path under the old (laxer) matcher,
    // clean it up while we're here.
    deleteCanopyEntry(opts.db, opts.projectId, rel);
    return { ok: false, reason: 'excluded', relPath: rel };
  }

  if (!fs.existsSync(path.join(opts.projectRoot, rel))) {
    deleteCanopyEntry(opts.db, opts.projectId, rel);
    return { ok: true, action: 'deleted', relPath: rel };
  }

  const result = scanFile({
    projectId: opts.projectId,
    machineId: opts.machineId,
    projectRoot: opts.projectRoot,
    relPath: rel,
    now: epochSeconds(),
    maxBytes: opts.maxBytes,
  });
  if (!result.ok) return { ok: false, reason: 'skipped', relPath: rel };

  upsertCanopyEntry(opts.db, result.entry);
  return { ok: true, action: 'upserted', relPath: rel };
}

function relativise(projectRoot: string, filePath: string): string | null {
  const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(projectRoot, filePath);
  const rootAbs = path.resolve(projectRoot);
  const rel = path.relative(rootAbs, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}
