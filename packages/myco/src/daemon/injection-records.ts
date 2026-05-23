/**
 * Universal Myco injection-record primitive.
 *
 * Every Myco-side injection (Cortex preamble at session-start, spores per
 * user prompt, Canopy entries on tool reads) records itself as a synthetic
 * row in the `activities` table with a deterministic `content_hash`. The
 * existing UNIQUE index on `(project_id, content_hash)` enforces dedup
 * structurally; concurrent racers can't both insert.
 *
 * `content_hash` format encodes session into the key so dedup is per-session
 * within a project:
 *
 *   myco:inject:cortex:<sessionId>
 *   myco:inject:spores:<sessionId>:<promptHash>
 *   myco:inject:canopy:<sessionId>:<filePath>
 */

import { getDatabase } from '@myco/db/client.js';
import { insertActivity, type ActivityRow } from '@myco/db/queries/activities.js';
import { getLatestBatch } from '@myco/db/queries/batches.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { epochSeconds } from '@myco/constants.js';

const INJECTION_OUTPUT_STORE_LIMIT = 8000;

export type InjectionType = 'cortex' | 'spores' | 'canopy';

export interface InjectionTrigger {
  /** What initiated this injection (e.g. for spores: prompt hash + preview). */
  metadata?: Record<string, unknown>;
}

export interface InjectionFetchResult {
  /** The content to inject into the agent's context. */
  text: string;
  /** Optional metadata describing what was fetched (e.g. source='cortex', spores=[...ids]). */
  metadata?: Record<string, unknown>;
}

export interface RecordInjectionOptions {
  sessionId: string;
  projectId: string | null;
  injectionType: InjectionType;
  /** Optional discriminator appended to the content_hash for per-prompt / per-file scope. */
  discriminator?: string;
  /** Optional trigger metadata stored on the activity row's tool_input. */
  trigger?: InjectionTrigger;
  /** Fetch the content to inject. Only invoked when the dedup gate passes. */
  fetchContent: () => Promise<InjectionFetchResult>;
}

export type RecordInjectionResult =
  | { injected: true; text: string; activityId: number; metadata?: Record<string, unknown> }
  | { injected: false; reason: 'already_recorded' | 'no_batch' | 'unique_violation' };

/**
 * Build the deterministic `content_hash` for an injection record.
 */
export function buildInjectionContentHash(
  injectionType: InjectionType,
  sessionId: string,
  discriminator?: string,
): string {
  const base = `myco:inject:${injectionType}:${sessionId}`;
  return discriminator && discriminator.length > 0 ? `${base}:${discriminator}` : base;
}

/**
 * Atomic dedup-gated injection record.
 *
 * 1. Builds `content_hash` from (type, sessionId, discriminator).
 * 2. Attempts INSERT of a placeholder activity row (tool_output_summary NULL).
 *    The UNIQUE index on `(project_id, content_hash)` is the dedup gate —
 *    a duplicate INSERT throws SqliteError `SQLITE_CONSTRAINT_UNIQUE`.
 * 3. On success: calls `fetchContent()`, UPDATEs the same row with the
 *    truncated injected text, returns `{ injected: true, text }`.
 * 4. On UNIQUE violation: returns `{ injected: false, reason: 'already_recorded' }`
 *    without invoking the fetch.
 * 5. If no `prompt_batches` row is open for the session, returns
 *    `{ injected: false, reason: 'no_batch' }` — the caller decides whether
 *    to skip or to create a batch first.
 *
 * Note: this function does NOT increment `session.tool_count`. Injection
 * activities are bookkeeping rows, not agent tool usage.
 */
export async function recordInjectionActivity(
  options: RecordInjectionOptions,
): Promise<RecordInjectionResult> {
  const { sessionId, projectId, injectionType, discriminator, trigger, fetchContent } = options;

  const latestBatch = getLatestBatch(sessionId);
  if (!latestBatch) {
    return { injected: false, reason: 'no_batch' };
  }

  const contentHash = buildInjectionContentHash(injectionType, sessionId, discriminator);
  const toolName = `myco:inject_${injectionType}`;
  const now = epochSeconds();

  let activity: ActivityRow;
  try {
    activity = insertActivity({
      project_id: projectId,
      session_id: sessionId,
      prompt_batch_id: latestBatch.id,
      tool_name: toolName,
      tool_input: trigger?.metadata ? JSON.stringify(trigger.metadata) : null,
      tool_output_summary: null,
      timestamp: now,
      content_hash: contentHash,
      created_at: now,
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { injected: false, reason: 'unique_violation' };
    }
    throw err;
  }

  let fetched: InjectionFetchResult;
  try {
    fetched = await fetchContent();
  } catch (err) {
    // Fetch failed AFTER the INSERT — leave the placeholder row in place so
    // a retry collides on the UNIQUE index rather than refetching. Operators
    // can identify failed injections by `tool_output_summary IS NULL` on a
    // `myco:*` activity row.
    throw err;
  }

  const truncated = (fetched.text ?? '').slice(0, INJECTION_OUTPUT_STORE_LIMIT);
  getDatabase()
    .prepare(`UPDATE activities SET tool_output_summary = ? WHERE id = ?`)
    .run(truncated, activity.id);

  return {
    injected: true,
    text: fetched.text,
    activityId: activity.id,
    metadata: fetched.metadata,
  };
}

/**
 * Check whether a given session has a recorded injection of the given type
 * (and optional discriminator). Pure read; no side effects. Useful for
 * callers that want to peek the dedup state before composing trigger
 * metadata.
 */
export function hasInjectionRecord(
  sessionId: string,
  injectionType: InjectionType,
  discriminator?: string,
): boolean {
  const contentHash = buildInjectionContentHash(injectionType, sessionId, discriminator);
  const db = getDatabase();
  const row = db
    .prepare(`SELECT id FROM activities WHERE session_id = ? AND content_hash = ? LIMIT 1`)
    .get(sessionId, contentHash) as { id: number } | undefined | null;
  return row !== undefined && row !== null;
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code ?? '';
  const message = (err as { message?: string }).message ?? '';
  return code.startsWith('SQLITE_CONSTRAINT') && message.includes('UNIQUE');
}

// ALL_PROJECTS_SCOPE re-export retained for callers that import from this module.
export { ALL_PROJECTS_SCOPE };
