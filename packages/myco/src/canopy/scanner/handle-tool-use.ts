import { rescanSingle } from './rescan-single.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { getManifestByName } from '../../symbionts/detect.js';
import { extractMutatedPath } from '../../symbionts/canopy-read-tools.js';
import type { Database } from 'bun:sqlite';
import type { DaemonLogger } from '../../daemon/logger.js';

export interface HandleToolUseOptions {
  db: Database;
  logger: DaemonLogger;
  machineId: string;
  projectRoot: string;
  projectId: string;
  /** Owning agent — selects whose manifest mutation vocabulary applies. */
  agent: string;
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
 *
 * Which tool calls count as file mutations — and where the path lives on
 * `tool_input` — comes from the agent's manifest (`pathBearingTools`
 * entries flagged `mutates: true`), the same declarations capture uses to
 * populate `activities.file_path`. That covers each agent's own write
 * vocabulary (pi's lowercase `edit`/`write`, codex's `apply_patch`
 * envelope, Claude Code's `Write`/`Edit`/`MultiEdit`/`NotebookEdit`)
 * where the retired hardcoded list matched Claude Code names only.
 */
export function handleCanopyToolUse(opts: HandleToolUseOptions): void {
  const resolved = extractMutatedPath(getManifestByName(opts.agent), opts.toolName, opts.toolInput);
  if (!resolved) return;
  try {
    const result = rescanSingle({
      db: opts.db,
      projectId: opts.projectId,
      machineId: opts.machineId,
      projectRoot: opts.projectRoot,
      filePath: resolved.filePath,
      defaultExcludePatterns: opts.defaultExcludePatterns,
      excludePatterns: opts.excludePatterns,
    });
    if (result.ok) {
      opts.logger.debug(LOG_KINDS.CANOPY_RESCAN, 'Canopy single-file rescan', {
        action: result.action,
        path: result.relPath,
        tool: opts.toolName,
        agent: opts.agent,
      });
    }
  } catch (err) {
    opts.logger.warn(LOG_KINDS.CANOPY_ERROR, 'Canopy rescan failed', {
      error: (err as Error).message,
      tool: opts.toolName,
      agent: opts.agent,
      path: resolved.filePath,
    });
  }
}
