/**
 * POST /canopy/inject — PreToolUse Canopy injection endpoint.
 *
 * Inputs (POST body):
 *   { sessionId: string, agent: string, toolInput: { file_path?, offset?, limit? } }
 *
 * Output:
 *   { inject: true,  blob: string, injectionTokens: number, path: string }
 *   { inject: false, reason: 'capability_off' | 'disabled' | 'targeted'
 *                          | 'unknown_file' | 'small_file' }
 *
 * Side effect on `inject: true`: records the (sessionId, file_path) →
 * tokens linkage in the in-memory pending registry so the PostToolUse
 * activity-insert path can write `canopy_injection_tokens` onto the new
 * row.
 *
 * The endpoint is purely SQLite + config reads; sub-millisecond budget.
 * Errors degrade to `{ inject: false, reason: 'unknown_file' }` so the
 * hook never blocks the agent's tool call. The hook handler also has its
 * own error guard, but defense in depth is cheap here.
 */

import path from 'node:path';
import { z } from 'zod';
import { resolveCanopyProjectId } from '../../canopy/identity.js';
import { resolveProjectRoot } from '../../vault/resolve.js';
import type { MycoConfig } from '../../config/schema.js';
import type { CanopyEntry } from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import type { RouteResponse } from '../router.js';
import { errorBody } from './error-envelope.js';
import { composeBlob, blobTokenCost } from '../../canopy/inject/compose.js';
import { decide, type IntentDecision, type NoInjectionReason } from '../../canopy/inject/filter.js';
import { recordPendingInjection } from '../../canopy/inject/pending.js';
import { symbiontHasCapability } from '../../symbionts/capabilities.js';

export interface CanopyInjectDeps {
  liveConfig: { current: MycoConfig };
  vaultDir: string;
  getDatabase: () => Database;
}

const InjectBody = z.object({
  sessionId: z.string().trim().min(1),
  agent: z.string().trim().min(1).optional(),
  toolInput: z.object({
    file_path: z.string().optional(),
    offset: z.number().int().optional(),
    limit: z.number().int().optional(),
  }).passthrough(),
});

interface InjectResponseBody {
  inject: boolean;
  blob?: string;
  injectionTokens?: number;
  path?: string;
  reason?: NoInjectionReason;
}

/** Look up a single canopy_entries row by (project_id, path). */
function lookupEntry(db: Database, projectId: string, filePath: string): CanopyEntry | null {
  const row = db.prepare(
    `SELECT
       project_id, machine_id, path, content_hash, size_bytes,
       token_estimate, line_count, language, exports_json, imports_json,
       top_comment, mechanical_updated_at, llm_description, llm_updated_at
     FROM canopy_entries
     WHERE project_id = ? AND path = ?`,
  ).get(projectId, filePath) as CanopyEntry | undefined;
  return row ?? null;
}

/**
 * Canopicalize the requested file_path to the repo-relative form used by
 * the scanner. Accepts absolute paths under the project root and trims
 * the prefix; passes already-relative paths through unchanged.
 */
export function relativizeForLookup(filePath: string, projectRoot: string): string {
  if (!filePath) return filePath;
  if (path.isAbsolute(filePath)) {
    const rel = path.relative(projectRoot, filePath);
    if (rel && !rel.startsWith('..')) return rel;
  }
  return filePath;
}

export function createCanopyInjectHandler(deps: CanopyInjectDeps) {
  return async function handleCanopyInject(req: { body: unknown }): Promise<RouteResponse> {
    const parsed = InjectBody.safeParse(req.body);
    if (!parsed.success) {
      return {
        status: 400,
        body: errorBody('invalid_request', parsed.error.message),
      };
    }
    const { sessionId, agent, toolInput } = parsed.data;
    const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined;

    const projectRoot = resolveProjectRoot(deps.vaultDir);
    const projectId = resolveCanopyProjectId(deps.vaultDir);
    const config = deps.liveConfig.current.cortex.canopy;

    const capabilityOn = symbiontHasCapability(agent, 'preToolUseInjection');

    let entry: CanopyEntry | null = null;
    if (filePath) {
      const lookupPath = relativizeForLookup(filePath, projectRoot);
      try {
        entry = lookupEntry(deps.getDatabase(), projectId, lookupPath);
      } catch {
        // DB unavailable — fall through with entry=null so the filter
        // returns unknown_file, the hook returns empty, the agent proceeds.
        entry = null;
      }
    }

    const decision: IntentDecision = decide({
      toolInput: {
        file_path: filePath,
        offset: toolInput.offset,
        limit: toolInput.limit,
      },
      entry,
      config: { enabled: config.inject_on_pre_tool_use, sizeThreshold: config.min_file_bytes },
      capabilityOn,
    });

    if (!decision.inject) {
      const body: InjectResponseBody = { inject: false, reason: decision.reason };
      return { body };
    }

    const blob = composeBlob(decision.entry);
    const injectionTokens = blobTokenCost(blob);

    if (filePath) {
      recordPendingInjection(sessionId, decision.entry.path, injectionTokens);
      if (filePath !== decision.entry.path) {
        recordPendingInjection(sessionId, filePath, injectionTokens);
      }
    }

    const body: InjectResponseBody = {
      inject: true,
      blob,
      injectionTokens,
      path: decision.entry.path,
    };
    return { body };
  };
}
