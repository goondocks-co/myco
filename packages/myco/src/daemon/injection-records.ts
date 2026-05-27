/**
 * Universal Myco injection-record primitive.
 *
 * Records each Myco-side injection (Cortex, spores, Canopy, subagent primer) as a synthetic
 * row in `activities` with a deterministic `content_hash`. The UNIQUE
 * index on `(project_id, content_hash)` enforces dedup structurally.
 *
 * `content_hash` format:
 *   myco:inject:cortex:<sessionId>
 *   myco:inject:spores:<sessionId>:<promptHash>
 *   myco:inject:canopy:<sessionId>:<filePath>
 *   myco:inject:subagent:<sessionId>:<agentIdOrType>
 */

import { getDatabase } from '@myco/db/client.js';
import { insertActivity, type ActivityRow } from '@myco/db/queries/activities.js';
import { getLatestBatch, incrementActivityCount } from '@myco/db/queries/batches.js';
import { epochSeconds } from '@myco/constants.js';

const INJECTION_OUTPUT_STORE_LIMIT = 8000;

export type InjectionType = 'cortex' | 'spores' | 'canopy' | 'subagent';

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
 * Inserts a placeholder activity row, then UPDATEs it with the fetched
 * text. The placeholder INSERT is what hits the UNIQUE index — a duplicate
 * `content_hash` throws SqliteError `SQLITE_CONSTRAINT_UNIQUE` and the
 * fetch never runs.
 *
 * Result shapes:
 *   { injected: true, text, activityId, metadata }
 *   { injected: false, reason: 'unique_violation' }  duplicate gate
 *   { injected: false, reason: 'no_batch' }          session has no open batch
 *
 * A `fetchContent()` throw leaves the placeholder row in place
 * (`tool_output_summary IS NULL`), so a retry collides on the UNIQUE index
 * rather than refetching. Operators identify failed injections by querying
 * `myco:*` rows with NULL output_summary.
 *
 * Does NOT bump `session.tool_count` — injections are bookkeeping, not
 * agent tool usage.
 */
export async function recordInjectionActivity(
  options: RecordInjectionOptions,
): Promise<RecordInjectionResult> {
  const { sessionId, projectId, injectionType, discriminator, trigger, fetchContent } = options;

  // Cortex injection fires during SessionStart, BEFORE any
  // UserPromptSubmit. For single-shot SessionStart symbionts
  // (Codex, Claude Code, Cursor) that means no batch exists yet.
  // Create a sentinel batch via the standard recovery shape so the
  // cortex activity has somewhere to land. `handleUserPrompt`
  // detects this sentinel on the next real prompt and REPLACES its
  // user_prompt rather than inserting a parallel batch — preserves
  // the 1:1 batch:turn mapping and keeps the cortex activity
  // attached to the right turn.
  //
  // Spores, canopy, and subagent injections fire AFTER a batch already
  // exists (UserPromptSubmit / PreToolUse / SubagentStart inside a
  // delegated turn respectively), so the no-batch path stays the legacy
  // 'no_batch' fall-through for those — they shouldn't manufacture sentinels.
  let latestBatch = getLatestBatch(sessionId);
  if (!latestBatch) {
    if (injectionType !== 'cortex') {
      return { injected: false, reason: 'no_batch' };
    }
    // Best-effort sentinel-bootstrap. Wrapped in try/catch because
    // unit tests sometimes exercise this handler with a synthetic
    // session id that has no row in `sessions` — the FK on
    // `prompt_batches.session_id` would throw. In production the
    // session row always exists by the time `/context` is hit
    // (SessionStart fires `/sessions/register` first), so the throw
    // path is purely a test-isolation safety net.
    try {
      const { ensureOpenBatch } = await import('./event-handlers.js');
      ensureOpenBatch(sessionId);
      latestBatch = getLatestBatch(sessionId);
    } catch { /* session row absent — keep legacy fall-through */ }
    if (!latestBatch) {
      return { injected: false, reason: 'no_batch' };
    }
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

  // Bump prompt_batches.activity_count so the UI's per-batch Tool Calls
  // section surfaces the injection row. session.tool_count stays untouched.
  incrementActivityCount(latestBatch.id);

  const fetched = await fetchContent();

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
 * Wraps `recordInjectionActivity` and returns whether the caller should
 * suppress its response. Suppress only when the UNIQUE gate fired
 * (`unique_violation`) — that's the dedup we want. `no_batch` falls
 * through (caller proceeds with the injection text, no activity recorded)
 * so symbionts whose hook fires before any prompt_batches row exists
 * still see Cortex / spores on their first tool use.
 */
export async function recordInjectionAndShouldSuppress(
  options: RecordInjectionOptions,
): Promise<{ suppress: boolean; result: RecordInjectionResult }> {
  const result = await recordInjectionActivity(options);
  const suppress = result.injected === false && result.reason === 'unique_violation';
  return { suppress, result };
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
