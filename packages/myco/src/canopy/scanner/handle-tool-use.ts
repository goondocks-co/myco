import { rescanSingle } from './rescan-single.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { Database } from 'bun:sqlite';
import type { DaemonLogger } from '../../daemon/logger.js';

/**
 * Tool names whose tool_use events warrant a single-file rescan. Kept in
 * sync with the symbiont-adapter file-mutation vocabulary so a new tool
 * (e.g. `MultiEdit`) can join the list in one place.
 */
const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

export interface HandleToolUseOptions {
  db: Database;
  logger: DaemonLogger;
  machineId: string;
  projectRoot: string;
  projectId: string;
  toolName: string;
  toolInput: unknown;
  /** Myco baseline from `canopy.exclude.default_patterns`. */
  defaultExcludePatterns?: string[];
  /** User-custom exclude patterns from `canopy.exclude.patterns`. */
  excludePatterns?: string[];
}

/**
 * Bridge from the daemon's `tool_use` event dispatcher into the canopy
 * scanner. Synchronous and best-effort: any failure is logged at warn and
 * swallowed so capture-pipeline traffic is never blocked by canopy.
 */
export function handleCanopyToolUse(opts: HandleToolUseOptions): void {
  if (!FILE_MUTATING_TOOLS.has(opts.toolName)) return;
  const filePath = extractPath(opts.toolInput);
  if (!filePath) return;
  try {
    const result = rescanSingle({
      db: opts.db,
      projectId: opts.projectId,
      machineId: opts.machineId,
      projectRoot: opts.projectRoot,
      filePath,
      defaultExcludePatterns: opts.defaultExcludePatterns,
      excludePatterns: opts.excludePatterns,
    });
    if (result.ok) {
      opts.logger.debug(LOG_KINDS.CANOPY_RESCAN, 'Canopy single-file rescan', {
        action: result.action,
        path: result.relPath,
        tool: opts.toolName,
      });
    }
  } catch (err) {
    opts.logger.warn(LOG_KINDS.CANOPY_ERROR, 'Canopy rescan failed', {
      error: (err as Error).message,
      tool: opts.toolName,
      path: filePath,
    });
  }
}

function extractPath(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const o = toolInput as Record<string, unknown>;
  // Claude Code variants — normalised across Read/Write/Edit toolschemas.
  for (const key of ['file_path', 'path', 'filePath', 'notebook_path']) {
    const v = o[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** Exported for tests that want to assert the trigger list contents. */
export const FILE_MUTATING_TOOLS_LIST: readonly string[] = [...FILE_MUTATING_TOOLS];
