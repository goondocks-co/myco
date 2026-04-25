import { createExcludeMatcher } from '../exclude.js';
import { walkProject } from './walk.js';
import { scanFile, DEFAULT_MAX_FILE_BYTES } from './scan-file.js';
import { upsertCanopyEntry, deleteMissingEntries } from './upsert.js';
import { epochSeconds } from '@myco/constants.js';
import type { Database } from 'bun:sqlite';
import type { CanopyScanResult } from '../types.js';

export interface ScanProjectOptions {
  db: Database;
  projectId: string;
  machineId: string;
  projectRoot: string;
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
  const isExcluded = createExcludeMatcher(opts.excludePatterns);
  const visited = new Set<string>();
  let scanned = 0;
  let added = 0; // populated below from changes-tracking
  let updated = 0;
  let errored = 0;

  // To distinguish add from update without an extra SELECT per row, sample
  // existing paths once up-front. The cost is one bounded query at start;
  // every subsequent decision is an O(1) Set check.
  const existing = new Set<string>(
    (opts.db.prepare(
      'SELECT path FROM canopy_entries WHERE project_id = ?',
    ).all(opts.projectId) as { path: string }[]).map((r) => r.path),
  );

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
    upsertCanopyEntry(opts.db, result.entry);
    if (existing.has(relPath)) updated++;
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
