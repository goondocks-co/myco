/**
 * Stateless event handler functions for the Myco daemon capture layer.
 *
 * These handlers are pure/stateless — they have no closure dependencies on
 * main() and are extracted here for testability and modularity.
 */

import path from 'node:path';
import { getDatabase } from '@myco/db/client.js';
import { epochSeconds, DEFAULT_AGENT_ID } from '@myco/constants.js';
import { getTeamMachineId } from './team-context.js';
import { closeOpenBatches, insertBatchStateless, incrementActivityCount, findOpenParentBatch, hasAnyBatch, countBatchesBySession, listBatchesBySession, getLatestBatch, replaceRecoveredBatchUserPrompt, BATCH_KIND, RECOVERED_BATCH_SENTINEL } from '@myco/db/queries/batches.js';
import { AntigravityJsonlParser } from '@myco/symbionts/parsers/antigravity-jsonl.js';
import fs from 'node:fs';
import type { StatelessActivityInsert, ActivityRow } from '@myco/db/queries/activities.js';
import { insertActivityWithBatch } from '@myco/db/queries/activities.js';
import { updateSession } from '@myco/db/queries/sessions.js';
import { ALL_PROJECTS_SCOPE, assertGroveProjectId } from '@myco/grove/ids.js';
import { createBatchLineage } from '@myco/db/queries/lineage.js';
import { consumePendingInjection } from '@myco/canopy/inject/pending.js';
import { getManifestByName } from '@myco/symbionts/detect.js';
import { extractAnyPath } from '@myco/symbionts/canopy-read-tools.js';

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

/**
 * Extract a file path from tool input via the agent's manifest.
 *
 * Manifest-driven: consults `pathBearingTools` on the agent's symbiont
 * manifest — the broader sibling of `canopyReadTools` that covers
 * write-side tools (Write, Edit, MultiEdit) in addition to canopy reads.
 * Each entry declares either a structured `pathField` or a shell-arg
 * extraction with a `readCommands` allowlist (Codex's `sed -n '1,5p' x.ts`).
 *
 * Returns null when the agent has no manifest entry for the tool, the
 * input shape doesn't match, or the path field is missing. Per-event cost
 * is one memoized manifest lookup plus a small shell-quote parse.
 */
function extractToolFilePath(
  agent: string,
  toolName: string,
  toolInput: unknown,
): string | null {
  const manifest = getManifestByName(agent);
  if (!manifest) return null;
  const resolved = extractAnyPath(manifest, toolName, toolInput);
  return resolved ? resolved.filePath : null;
}

function relativizeToolPath(filePath: string, projectRoot: string): string {
  if (!path.isAbsolute(filePath)) return filePath;
  const rel = path.relative(projectRoot, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return filePath;
  return rel.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Event handling helpers (exported for testing)
// ---------------------------------------------------------------------------

export interface UserPromptOptions {
  kind?: string;
}

/**
 * Open a synthetic `kind='recovered'` batch ONLY when the session has
 * no batches at all. Activity handlers call this before insert so that
 * the FK on `activities.prompt_batch_id` is satisfied even for a session
 * whose first observed event is a tool_use (or similar) instead of a
 * user_prompt.
 *
 * Late post-turn bookkeeping events (subagent_stop, task_completed,
 * compact, stop_failure) used to fabricate a phantom row here whenever
 * the turn's INITIAL batch had already closed. They no longer do — the
 * relaxed inline subquery in `insertActivityWithBatch` falls back to the
 * just-closed batch instead, so the activity stays attached to the turn
 * it belongs to.
 */
export function ensureOpenBatch(sessionId: string): void {
  if (hasAnyBatch(sessionId)) return;
  const now = epochSeconds();
  insertBatchStateless({
    session_id: sessionId,
    user_prompt: RECOVERED_BATCH_SENTINEL,
    started_at: now,
    created_at: now,
    machine_id: getTeamMachineId(),
    kind: BATCH_KIND.RECOVERED,
    parent_prompt_batch_id: null,
  });
}

const antigravityParser = new AntigravityJsonlParser();

/**
 * Best-effort recovery of an Antigravity session's user prompt(s)
 * from the transcript file, accounting for two pieces of existing
 * state the Antigravity integration already keeps:
 *
 *   - The first batch may be the {@link RECOVERED_BATCH_SENTINEL}
 *     placeholder written by {@link ensureOpenBatch}. When the IDE
 *     finally flushes its transcript, this routine REPLACES the
 *     sentinel with the real first-turn prompt via
 *     {@link replaceRecoveredBatchUserPrompt} (idempotent — bails
 *     when the row is no longer the sentinel).
 *
 *   - Injection records (cortex / spores / canopy) live in
 *     `injection-records.ts` keyed by `(sessionId, content_hash)`.
 *     This routine does NOT trigger re-injection — it only
 *     reconciles the visible prompt text. The injection step
 *     already self-deduplicates if a later code path retriggers it.
 *
 * Called on every tool_use for Antigravity. Cheap when the
 * transcript hasn't changed: a stat-and-fast-bail design would be
 * marginal — the parser cost on a real session transcript is
 * sub-millisecond, and the early-exit when no sentinel exists
 * already trims the hot path.
 */
function selfHealAntigravityPromptFromTranscript(
  sessionId: string,
  transcriptPath: string,
): void {
  // Cheap precondition: only proceed when this session still has a
  // sentinel batch sitting at the head. If it doesn't, the prompt
  // is already correct and nothing to heal.
  const earliest = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE, limit: 1 });
  if (earliest.length === 0) return;
  if (earliest[0].user_prompt !== RECOVERED_BATCH_SENTINEL) return;

  let content: string;
  try { content = fs.readFileSync(transcriptPath, 'utf-8'); }
  catch { return; }

  const prompts = antigravityParser
    .parseTurns(content)
    .map((t) => t.prompt)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (prompts.length === 0) return;

  // Replace the sentinel with the first real prompt. Idempotent —
  // returns false if the row has already been healed by another
  // event (e.g. a parallel post-tool-use, or session-reenrich at
  // Stop). Either path leaves the user with the right answer.
  replaceRecoveredBatchUserPrompt(earliest[0].id, prompts[0]);

  // If the transcript advanced beyond the sentinel turn while no
  // user_prompt hook ever fired for the tail (Antigravity does not
  // have a per-prompt hook), reuse syncTranscriptPromptBatches to
  // append the missing batches. Idempotent via its count check.
  if (prompts.length > 1) {
    try { syncTranscriptPromptBatches(sessionId, prompts); }
    catch { /* best-effort */ }
  }
}

/**
 * Invariant: every activity insert increments the linked batch's
 * `activity_count`. Pre-PR-#346 only `handleToolUse` honored it; the
 * bookkeeping handlers (subagent_*, task_completed, compact, stop_failure)
 * silently skipped the increment, so the cached column drifted from the
 * real row count on every batch they touched. Routing all callers through
 * this one helper makes the drift impossible.
 */
function recordActivity(data: StatelessActivityInsert): ActivityRow {
  const activity = insertActivityWithBatch(data);
  if (activity.prompt_batch_id !== null) {
    incrementActivityCount(activity.prompt_batch_id);
  }
  return activity;
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
    // Sentinel-replace fast path. When `/context` (cortex / spores /
    // canopy) fired before any UserPromptSubmit, it created a
    // sentinel batch via `ensureOpenBatch` so the injection activity
    // had somewhere to land. If that sentinel is the ONLY batch and
    // the incoming kind is INITIAL, replace its `user_prompt` in
    // place instead of inserting a new batch — preserves the 1:1
    // batch:turn mapping and keeps the cortex injection row attached
    // to the right turn.
    if (effectiveKind === BATCH_KIND.INITIAL && prompt) {
      const latest = getLatestBatch(sessionId);
      if (
        latest
        && latest.user_prompt === RECOVERED_BATCH_SENTINEL
        && countBatchesBySession(sessionId) === 1
      ) {
        replaceRecoveredBatchUserPrompt(latest.id, prompt);
        // Cache bump already happened when the sentinel was inserted;
        // replace doesn't change the row count.
        try {
          const lineageProjectId = latest.project_id ? assertGroveProjectId(latest.project_id) : null;
          createBatchLineage(DEFAULT_AGENT_ID, sessionId, latest.id, now, lineageProjectId);
        } catch { /* lineage best-effort */ }
        return { batchId: latest.id, promptNumber: latest.prompt_number ?? 1 };
      }
    }
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

  try {
    const lineageProjectId = batch.project_id ? assertGroveProjectId(batch.project_id) : null;
    createBatchLineage(DEFAULT_AGENT_ID, sessionId, batch.id, now, lineageProjectId);
  } catch { /* lineage best-effort */ }

  // `sessions.prompt_count` cache bump is folded into
  // `insertBatchStateless` so it's atomic with the row write —
  // see the function comment for the single-writer rationale.

  return { batchId: batch.id, promptNumber };
}

/**
 * Sync a session's prompt_batches against an ordered list of user prompts
 * mined from the agent's transcript. Inserts batches for any prompts beyond
 * the count already captured for the session; existing batches are left
 * alone. Used by symbionts (Antigravity) whose hook payloads do not carry
 * the user prompt — the transcript is the authoritative source and the
 * hook handler reads it on every fire to keep the DB in sync.
 *
 * Count-based diff means callers can POST the full prompt list every call;
 * the server only creates batches for the new tail.
 */
export function syncTranscriptPromptBatches(
  sessionId: string,
  prompts: string[],
): { createdBatchCount: number; existingBatchCount: number } {
  // countBatchesBySession is a SELECT COUNT(*); listBatchesBySession caps
  // at BATCHES_DEFAULT_LIMIT and would saturate at 200 — then re-insert
  // prompts[200..N] as duplicates on every hook fire.
  const existingBatchCount = countBatchesBySession(sessionId);
  if (existingBatchCount >= prompts.length) {
    return { createdBatchCount: 0, existingBatchCount };
  }

  // Insert the new tail in a single transaction — N user prompts at AGY
  // session cold-start could otherwise pay N fsyncs. Direct
  // insertBatchStateless skips handleUserPrompt's closeOpenBatches step,
  // which would collapse turn boundaries when N synthetic batches are
  // written in one sweep.
  const now = epochSeconds();
  let createdBatchCount = 0;
  const machineId = getTeamMachineId();

  const insertTail = getDatabase().transaction(() => {
    for (let i = existingBatchCount; i < prompts.length; i++) {
      const prompt = prompts[i];
      if (typeof prompt !== 'string' || prompt.trim().length === 0) continue;
      const batch = insertBatchStateless({
        session_id: sessionId,
        user_prompt: prompt,
        started_at: now,
        created_at: now,
        machine_id: machineId,
        kind: BATCH_KIND.INITIAL,
        parent_prompt_batch_id: null,
      });
      try {
        const lineageProjectId = batch.project_id ? assertGroveProjectId(batch.project_id) : null;
        createBatchLineage(DEFAULT_AGENT_ID, sessionId, batch.id, now, lineageProjectId);
      } catch { /* lineage best-effort */ }
      // Counter bump is atomic inside insertBatchStateless.
      createdBatchCount += 1;
    }
  });
  insertTail();

  return { createdBatchCount, existingBatchCount };
}

/**
 * Handle a PostToolUse event: ensure a batch is open (opening a
 * synthetic recovery batch if necessary) and insert the activity
 * linked to it.
 */
export function handleToolUse(
  sessionId: string,
  agent: string,
  toolName: string,
  toolInput: unknown,
  toolOutput: string | undefined,
  projectRoot: string,
  transcriptPath?: string,
): void {
  const now = epochSeconds();

  ensureOpenBatch(sessionId);

  // Daemon-side self-heal: when a `RECOVERED_BATCH_SENTINEL` placeholder
  // exists for this session AND the event carries a transcript path,
  // re-read the transcript and overwrite the sentinel with the real
  // user prompt. The Antigravity IDE writes its transcript file
  // asynchronously after the PreInvocation hook fires, so the initial
  // session-start sync can miss the prompt — every subsequent
  // tool_use is a chance to heal. Idempotent: bails immediately when
  // no sentinel batch exists for this session.
  if (transcriptPath && agent === 'antigravity') {
    try { selfHealAntigravityPromptFromTranscript(sessionId, transcriptPath); }
    catch { /* best-effort heal */ }
  }

  const filePath = extractToolFilePath(agent, toolName, toolInput);
  const activityFilePath = filePath ? relativizeToolPath(filePath, projectRoot) : null;

  // Canopy linkage: if a PreToolUse injection was recorded for this
  // (sessionId, file_path), capture the offered token count before INSERT
  // so it lands in the same row write — no follow-up UPDATE needed.
  // Try the relativized path first (the form PreToolUse uses for paths
  // under projectRoot) and fall back to the raw path for absolute reads
  // that didn't relativize.
  let injectionTokens: number | null = null;
  if (filePath) {
    injectionTokens =
      consumePendingInjection(sessionId, activityFilePath ?? filePath)
      ?? (activityFilePath !== filePath ? consumePendingInjection(sessionId, filePath) : null);
  }

  recordActivity({
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput ? JSON.stringify(toolInput).slice(0, TOOL_INPUT_STORE_LIMIT) : null,
    tool_output_summary: toolOutput?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    file_path: activityFilePath,
    timestamp: now,
    created_at: now,
    canopy_injection_tokens: injectionTokens,
  });

  // `sessions.tool_count` cache bump is folded into the activity
  // insert itself — see `insertActivityWithBatch`.
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
  agent: string,
  toolName: string,
  toolInput: unknown,
  error: string | undefined,
  isInterrupt: boolean | undefined,
): void {
  const now = epochSeconds();
  const filePath = extractToolFilePath(agent, toolName, toolInput);

  ensureOpenBatch(sessionId);

  recordActivity({
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
  ensureOpenBatch(sessionId);
  recordActivity({
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
  ensureOpenBatch(sessionId);
  recordActivity({
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
  ensureOpenBatch(sessionId);
  recordActivity({
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
  ensureOpenBatch(sessionId);
  recordActivity({
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
  ensureOpenBatch(sessionId);
  recordActivity({
    session_id: sessionId,
    tool_name: `${phase}_compact`,
    tool_input: trigger ? JSON.stringify({ trigger }).slice(0, TOOL_INPUT_STORE_LIMIT) : null,
    tool_output_summary: compactSummary?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    timestamp: now,
    created_at: now,
  });
}
