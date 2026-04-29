import fs from 'node:fs';
import path from 'node:path';
import { createLayeredExcludeMatcher } from '../exclude.js';
import { walkProject } from './walk.js';
import { scanFile, DEFAULT_MAX_FILE_BYTES } from './scan-file.js';
import {
  upsertCanopyEntry,
  deleteMissingEntries,
  listExistingHashes,
} from './upsert.js';
import { epochSeconds } from '@myco/constants.js';
import type { Database } from 'bun:sqlite';
import type { CanopyScanResult } from '../types.js';

export interface DeltaScanOptions {
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
 * Incremental scan: walk every file but skip the parse/hash step when the
 * stored size matches the current stat. This is the cheap path used by
 * SessionStart and the periodic background job — typical idle repos finish
 * in well under a second after the initial populate.
 *
 * Trade-off: relying on size as a same-content shortcut can miss content
 * changes that happen to preserve byte length. The next full scan
 * (`scan-project`) reconciles those rare cases; the periodic background
 * scan can also be configured to run a full pass occasionally.
 */
export function deltaScan(opts: DeltaScanOptions): CanopyScanResult {
  const start = Date.now();
  const now = epochSeconds();
  const isExcluded = createLayeredExcludeMatcher({
    projectRoot: opts.projectRoot,
    defaultPatterns: opts.defaultExcludePatterns,
    userPatterns: opts.excludePatterns,
  });
  const existing = listExistingHashes(opts.db, opts.projectId);
  const visited = new Set<string>();
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES;

  let scanned = 0;
  let added = 0;
  let updated = 0;
  let errored = 0;

  for (const relPath of walkProject({ projectRoot: opts.projectRoot, isExcluded })) {
    scanned++;
    const prior = existing.get(relPath);

    if (prior) {
      // Cheap stat check: same size means same content with overwhelming
      // probability and matches what `git status` does at the same step.
      try {
        const stat = fs.statSync(path.join(opts.projectRoot, relPath));
        if (stat.size === prior.size_bytes && stat.size <= maxBytes) {
          visited.add(relPath);
          continue;
        }
      } catch {
        errored++;
        continue;
      }
    }

    const result = scanFile({
      projectId: opts.projectId,
      machineId: opts.machineId,
      projectRoot: opts.projectRoot,
      relPath,
      now,
      maxBytes,
    });
    if (!result.ok) {
      if (result.reason === 'read_error') errored++;
      continue;
    }
    visited.add(relPath);
    if (prior && result.entry.content_hash === prior.content_hash) {
      // Bytes changed but hash matches (rare — e.g. mtime touch); skip the
      // upsert so `mechanical_updated_at` isn't churned uselessly.
      continue;
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
