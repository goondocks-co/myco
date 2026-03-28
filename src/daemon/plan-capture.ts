/**
 * Event-driven plan capture module.
 *
 * Provides pure detection and storage functions for capturing plan files
 * written to watched directories. Called by the daemon's event handler
 * (Task 6) when a tool event targets a plan directory.
 *
 * All functions are stateless — no file I/O, no event handling.
 */

import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CONTENT_HASH_ALGORITHM } from '@myco/constants.js';
import { upsertPlan } from '@myco/db/queries/plans.js';
import type { PlanRow } from '@myco/db/queries/plans.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tool names that constitute a file write operation. */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'Create']);

/** Regex matching a top-level markdown heading (# Title). */
const HEADING_REGEX = /^#\s+(.+)$/m;

/** Number of hex chars to use from the MD5 hash for plan IDs. */
const PLAN_ID_HASH_LENGTH = 16;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a file path falls inside any watched plan directory.
 *
 * Both the file path and watch directories are resolved against projectRoot
 * before comparison, so relative and absolute paths both work correctly.
 */
export function isInPlanDirectory(
  filePath: string,
  watchDirs: string[],
  projectRoot: string,
): boolean {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
  return watchDirs.some((dir) => {
    // Expand ~ to home directory (manifests use ~/... for global plan dirs)
    const expanded = dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(2)) : dir;
    const absDir = path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
    // Ensure we match a directory boundary, not a prefix of a sibling dir name.
    // e.g. absDir = /foo/plans must NOT match /foo/plans-extra
    const prefix = absDir.endsWith(path.sep) ? absDir : absDir + path.sep;
    return abs === absDir || abs.startsWith(prefix);
  });
}

/** Configuration for plan directory matching. */
export interface PlanWatchConfig {
  watchDirs: string[];
  projectRoot: string;
  extensions?: string[];
}

/**
 * Check if a tool event is a file write to a plan directory.
 *
 * Returns the file path if it matches, null otherwise. Only Write, Edit,
 * and Create tools are considered. Extension filtering enforces the
 * `artifact_extensions` config setting (e.g. ['.md']).
 */
export function isPlanWriteEvent(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  config: PlanWatchConfig,
): string | null {
  if (!FILE_WRITE_TOOLS.has(toolName)) return null;
  const filePath = toolInput?.file_path ?? toolInput?.path;
  if (typeof filePath !== 'string') return null;
  if (!isInPlanDirectory(filePath, config.watchDirs, config.projectRoot)) return null;
  if (config.extensions?.length) {
    const ext = path.extname(filePath).toLowerCase();
    if (!config.extensions.includes(ext)) return null;
  }
  return filePath;
}

/**
 * Extract a plan title from markdown content.
 *
 * Looks for the first top-level heading (# Title). If none is found,
 * falls back to the provided filename. Returns null if neither is available.
 */
export function parsePlanTitle(content: string, filename?: string): string | null {
  const match = HEADING_REGEX.exec(content);
  if (match) return match[1].trim();
  return filename ?? null;
}

/** Input to capturePlan. */
export interface CapturePlanInput {
  /** Absolute or relative path to the source plan file. */
  sourcePath: string;
  /** Full markdown content of the plan file. */
  content: string;
  /** Session ID that triggered the write event. */
  sessionId: string;
  /** Optional prompt batch ID at the time of capture. */
  promptBatchId?: number | null;
}

/**
 * Store a plan in the database.
 *
 * The plan ID is derived deterministically from sourcePath (MD5 hash,
 * first 16 chars), so repeated writes to the same file upsert rather than
 * insert duplicate rows.
 *
 * The content hash (SHA256) is used by upsertPlan to decide whether to
 * reset the embedded flag — if the content is unchanged the flag is
 * preserved.
 */
export function capturePlan(input: CapturePlanInput): PlanRow {
  const now = Math.floor(Date.now() / 1000);
  const contentHash = createHash(CONTENT_HASH_ALGORITHM).update(input.content).digest('hex');
  const id = createHash('md5').update(input.sourcePath).digest('hex').slice(0, PLAN_ID_HASH_LENGTH);
  const title = parsePlanTitle(input.content, path.basename(input.sourcePath));

  return upsertPlan({
    id,
    title,
    content: input.content,
    source_path: input.sourcePath,
    session_id: input.sessionId,
    prompt_batch_id: input.promptBatchId ?? null,
    content_hash: contentHash,
    status: 'active',
    created_at: now,
    updated_at: now,
  });
}
