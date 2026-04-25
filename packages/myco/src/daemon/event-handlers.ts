/**
 * Stateless event handler functions for the Myco daemon capture layer.
 *
 * These handlers are pure/stateless — they have no closure dependencies on
 * main() and are extracted here for testability and modularity.
 */

import { epochSeconds, DEFAULT_AGENT_ID } from '@myco/constants.js';
import { getTeamMachineId } from './team-context.js';
import { closeOpenBatches, insertBatchStateless, incrementActivityCount, findOpenParentBatch, BATCH_KIND } from '@myco/db/queries/batches.js';
import { insertActivityWithBatch } from '@myco/db/queries/activities.js';
import { updateSession, incrementSessionToolCount } from '@myco/db/queries/sessions.js';
import { createBatchLineage } from '@myco/db/queries/lineage.js';
import { getDatabase } from '@myco/db/client.js';
import { consumePendingInjection } from '@myco/canopy/inject/pending.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max chars of tool input stored in the activity row. */
export const TOOL_INPUT_STORE_LIMIT = 4000;

/** Max chars of tool output summary stored in the activity row. */
export const TOOL_OUTPUT_STORE_LIMIT = 2000;

/** Max chars for deriving a title from the first user prompt. */
export const TITLE_PREVIEW_CHARS = 80;

/** Prefixes that identify system-injected messages (not real user prompts). */
export const SYSTEM_MESSAGE_PREFIXES = [
  '<task-notification>',
  '<system-reminder>',
] as const;

/** Returns true if the prompt is a system-injected message, not a real user prompt. */
export function isSystemMessage(prompt: string): boolean {
  const trimmed = prompt.trimStart();
  return SYSTEM_MESSAGE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Extract a file path from tool input across snake_case and camelCase conventions. */
function extractToolFilePath(toolInput: unknown): string | null {
  const inputObj = toolInput as Record<string, unknown> | undefined;
  if (!inputObj) return null;

  const filePath = inputObj.file_path;
  if (typeof filePath === 'string') return filePath;

  const camelFilePath = inputObj.filePath;
  if (typeof camelFilePath === 'string') return camelFilePath;

  return null;
}

// ---------------------------------------------------------------------------
// Event handling helpers (exported for testing)
// ---------------------------------------------------------------------------

export interface UserPromptOptions {
  kind?: string;
}

/**
 * Handle a UserPromptSubmit event.
 *
 * For initial prompts: closes open batches, opens a new initial batch.
 * For steering/interrupt: nests under the open parent if one exists;
 * falls back to initial if no open parent is found.
 *
 * The parent linkage is resolved server-side via findOpenParentBatch — callers
 * should not attempt to compute or pass a parent ID themselves.
 *
 * @returns the new batch ID and prompt number
 */
export function handleUserPrompt(
  sessionId: string,
  prompt: string | undefined,
  options: UserPromptOptions = {},
): { batchId: number; promptNumber: number } {
  const now = epochSeconds();
  const incomingKind = options.kind ?? BATCH_KIND.INITIAL;

  let parentId: number | null = null;
  let effectiveKind = incomingKind;

  if (incomingKind === BATCH_KIND.STEERING || incomingKind === BATCH_KIND.INTERRUPT) {
    const openParent = findOpenParentBatch(sessionId);
    if (openParent) {
      parentId = openParent.id;
    } else {
      effectiveKind = BATCH_KIND.INITIAL;
      parentId = null;
    }
  } else {
    closeOpenBatches(sessionId, now);
  }

  const batch = insertBatchStateless({
    session_id: sessionId,
    user_prompt: prompt ?? null,
    started_at: now,
    created_at: now,
    machine_id: getTeamMachineId(),
    kind: effectiveKind,
    parent_prompt_batch_id: parentId,
  });

  const promptNumber = batch.prompt_number!;

  try { createBatchLineage(DEFAULT_AGENT_ID, sessionId, batch.id, now); } catch { /* lineage best-effort */ }

  if (effectiveKind === BATCH_KIND.INITIAL) {
    updateSession(sessionId, { prompt_count: promptNumber });
  }

  return { batchId: batch.id, promptNumber };
}

/**
 * Handle a PostToolUse event: insert activity with inline batch linkage.
 *
 * Fully stateless — the batch ID is resolved via an inline subquery in
 * `insertActivityWithBatch`, so no in-memory state is needed.
 */
export function handleToolUse(
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  toolOutput: string | undefined,
): void {
  const now = epochSeconds();

  const filePath = extractToolFilePath(toolInput);

  const activity = insertActivityWithBatch({
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput ? JSON.stringify(toolInput).slice(0, TOOL_INPUT_STORE_LIMIT) : null,
    tool_output_summary: toolOutput?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    file_path: filePath,
    timestamp: now,
    created_at: now,
  });

  // Canopy linkage: if a PreToolUse injection was recorded for this
  // (sessionId, file_path), stamp the offered token count onto the new
  // activity row. NULL otherwise — Track C's aggregation treats that as
  // "no injection" for the call.
  if (filePath) {
    const injectionTokens = consumePendingInjection(sessionId, filePath);
    if (injectionTokens !== null) {
      try {
        getDatabase()
          .prepare('UPDATE activities SET canopy_injection_tokens = ? WHERE id = ?')
          .run(injectionTokens, activity.id);
      } catch {
        // Non-fatal: column missing on a downgraded schema or row vanished.
        // Aggregation falls back to NULL.
      }
    }
  }

  // Increment batch activity count if linked to a batch
  if (activity.prompt_batch_id !== null) {
    incrementActivityCount(activity.prompt_batch_id);
  }

  // Increment session-level tool_count atomically.
  incrementSessionToolCount(sessionId);
}

/**
 * Handle stop event: close all open batches for this session.
 *
 * Does NOT close the session — the Stop hook fires after every assistant
 * turn, not just session end. Session closure happens in /sessions/unregister
 * (SessionEnd hook).
 *
 * Fully stateless — uses `closeOpenBatches` (blind UPDATE) instead of
 * reading from an in-memory map.
 */
export function handleStopBatches(
  sessionId: string,
): void {
  closeOpenBatches(sessionId, epochSeconds());
}

/**
 * Handle a tool failure event: insert activity with success=0.
 */
export function handleToolFailure(
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  error: string | undefined,
  isInterrupt: boolean | undefined,
): void {
  const now = epochSeconds();
  const filePath = extractToolFilePath(toolInput);

  const activity = insertActivityWithBatch({
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput ? JSON.stringify(toolInput).slice(0, TOOL_INPUT_STORE_LIMIT) : null,
    tool_output_summary: error?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    file_path: filePath,
    success: 0,
    error_message: error?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? (isInterrupt ? 'interrupted' : null),
    timestamp: now,
    created_at: now,
  });

  if (activity.prompt_batch_id !== null) {
    incrementActivityCount(activity.prompt_batch_id);
  }
}

/**
 * Handle a subagent start event: record that a subagent was spawned.
 */
export function handleSubagentStart(
  sessionId: string,
  agentId: string | undefined,
  agentType: string | undefined,
): void {
  const now = epochSeconds();
  insertActivityWithBatch({
    session_id: sessionId,
    tool_name: 'subagent_start',
    tool_input: JSON.stringify({ agent_id: agentId, agent_type: agentType }).slice(0, TOOL_INPUT_STORE_LIMIT),
    timestamp: now,
    created_at: now,
  });
}

/**
 * Handle a subagent stop event: record that a subagent completed.
 */
export function handleSubagentStop(
  sessionId: string,
  agentId: string | undefined,
  agentType: string | undefined,
  lastAssistantMessage: string | undefined,
): void {
  const now = epochSeconds();
  insertActivityWithBatch({
    session_id: sessionId,
    tool_name: 'subagent_stop',
    tool_input: JSON.stringify({ agent_id: agentId, agent_type: agentType }).slice(0, TOOL_INPUT_STORE_LIMIT),
    tool_output_summary: lastAssistantMessage?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    timestamp: now,
    created_at: now,
  });
}

/**
 * Handle a stop failure event: record that the stop hook encountered an error.
 */
export function handleStopFailure(
  sessionId: string,
  error: string | undefined,
  errorDetails: string | undefined,
): void {
  const now = epochSeconds();
  insertActivityWithBatch({
    session_id: sessionId,
    tool_name: 'stop_failure',
    tool_output_summary: errorDetails?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    success: 0,
    error_message: error?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    timestamp: now,
    created_at: now,
  });
}

/**
 * Handle a task completed event: record task completion as an activity.
 */
export function handleTaskCompleted(
  sessionId: string,
  taskId: string | undefined,
  taskSubject: string | undefined,
  taskDescription: string | undefined,
): void {
  const now = epochSeconds();
  insertActivityWithBatch({
    session_id: sessionId,
    tool_name: 'task_completed',
    tool_input: JSON.stringify({ task_id: taskId, task_subject: taskSubject, task_description: taskDescription }).slice(0, TOOL_INPUT_STORE_LIMIT),
    tool_output_summary: taskSubject?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    timestamp: now,
    created_at: now,
  });
}

/**
 * Handle a compact event (pre or post): record compaction in the activity stream.
 */
export function handleCompact(
  sessionId: string,
  phase: 'pre' | 'post',
  trigger: string | undefined,
  compactSummary: string | undefined,
): void {
  const now = epochSeconds();
  insertActivityWithBatch({
    session_id: sessionId,
    tool_name: `${phase}_compact`,
    tool_input: trigger ? JSON.stringify({ trigger }).slice(0, TOOL_INPUT_STORE_LIMIT) : null,
    tool_output_summary: compactSummary?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    timestamp: now,
    created_at: now,
  });
}
