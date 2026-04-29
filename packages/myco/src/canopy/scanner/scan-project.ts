import { createLayeredExcludeMatcher } from '../exclude.js';
import { walkProject } from './walk.js';
import { scanFile, DEFAULT_MAX_FILE_BYTES } from './scan-file.js';
import { upsertCanopyEntry, deleteMissingEntries, listExistingHashes } from './upsert.js';
import { epochSeconds } from '@myco/constants.js';
import type { Database } from 'bun:sqlite';
import type { CanopyScanResult } from '../types.js';

export interface ScanProjectOptions {
  db: Database;
  projectId: string;
  machineId: string;
  projectRoot: string;
  /** Myco-maintained baseline from `canopy.exclude.default_patterns`. */
  defaultExcludePatterns: string[];
  /** User-additive list from `canopy.exclude.patterns`. */
  excludePatterns: string[];
  maxBytes?: number;
}

/**
 * Full project scan: walk every non-excluded file, parse and upsert each
 * row, then tombstone rows whose paths no longer exist on disk. Deterministic
 * given identical input — `now` is sampled once at entry.
 */
export function scanProject(opts: ScanProjectOptions): CanopyScanResult {
  const start = Date.now();
  const now = epochSeconds();
  const isExcluded = createLayeredExcludeMatcher({
    projectRoot: opts.projectRoot,
    defaultPatterns: opts.defaultExcludePatterns,
    userPatterns: opts.excludePatterns,
  });
  const visited = new Set<string>();
  let scanned = 0;
  let added = 0; // populated below from changes-tracking
  let updated = 0;
  let errored = 0;

  // Pre-load existing rows once so the loop can skip the upsert (and the
  // mechanical_updated_at bump) when content_hash is unchanged. Without this
  // guard, every full scan would mark every Tier 2 description stale and
  // re-queue it for canopy-describe even though nothing actually changed.
  const existing = listExistingHashes(opts.db, opts.projectId);

  for (const relPath of walkProject({ projectRoot: opts.projectRoot, isExcluded })) {
    scanned++;
    const result = scanFile({
      projectId: opts.projectId,
      machineId: opts.machineId,
      projectRoot: opts.projectRoot,
      relPath,
      now,
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES,
    });
    if (!result.ok) {
      // Skips for binary/too-large/symlink are expected and not errors.
      if (result.reason === 'read_error') errored++;
      continue;
    }
    visited.add(relPath);
    const prior = existing.get(relPath);
    if (prior && result.entry.content_hash === prior.content_hash) {
      continue; // unchanged → don't churn mechanical_updated_at
    }
    upsertCanopyEntry(opts.db, result.entry);
    if (prior) updated++;
    else added++;
  }

  const removed = deleteMissingEntries(opts.db, opts.projectId, visited);
  return {
    scanned,
    added,
    updated,
    removed,
    errored,
    durationMs: Date.now() - start,
  };
}
