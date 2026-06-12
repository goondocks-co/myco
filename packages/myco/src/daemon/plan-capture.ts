/**
 * Plan capture and persistence helpers.
 *
 * Provides pure detection and storage functions for capturing plans from
 * watched files, transcript tags, and direct daemon/MCP writes.
 *
 * All functions are stateless — no file I/O, no event handling.
 */

import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CONTENT_HASH_ALGORITHM } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { getPlanByLogicalKey, upsertPlan } from '@myco/db/queries/plans.js';
import type { PlanRow } from '@myco/db/queries/plans.js';
import { PROMPT_BATCH_ORIGIN, type PromptBatchOrigin } from '@myco/db/queries/batches.js';
import type { Logger } from './logger.js';
import {
  buildFilePlanLogicalKey,
  buildScopedPlanId,
  buildSessionTagPlanLogicalKey,
  humanizePlanToken,
  normalizePlanSourcePath,
  TRANSCRIPT_SOURCE_PREFIX,
} from '@myco/plans/identity.js';
import { planTagEnvelopeRegex } from '@myco/plans/tag-envelopes.js';

// ---------------------------------------------------------------------------
// Transcript-based plan extraction
// ---------------------------------------------------------------------------

/**
 * Extract plan content from XML-style tags in transcript text.
 *
 * Scans the input text for each declared tag name and returns all matches.
 * Tags are exact names (e.g., 'proposed_plan' matches `<proposed_plan>...</proposed_plan>`).
 * Returns all occurrences — the caller decides upsert semantics (e.g., last one wins).
 *
 * `origin` enforces the plan-capture contract: a captured plan represents
 * user intent. Synthesized envelopes (`<system-reminder>`, `<teammate-message>`,
 * `<task-notification>`, …) can contain quoted plan-tag fragments that would
 * otherwise leak into the plans table. Non-`'human'` origins short-circuit
 * to an empty list. Omit `origin` only for callers that have already filtered
 * upstream (e.g. transcript miner walking user-typed turns).
 */
export function extractTaggedPlans(
  text: string,
  tags: string[],
  origin: PromptBatchOrigin = PROMPT_BATCH_ORIGIN.HUMAN,
): Array<{ tag: string; content: string }> {
  if (origin !== PROMPT_BATCH_ORIGIN.HUMAN) return [];
  const results: Array<{ tag: string; content: string }> = [];
  for (const tag of tags) {
    // Shared envelope shape — `stripPlanTagEnvelopes` removes exactly what
    // this extracts, so persisted summaries can never retain an envelope
    // that extraction recognized (or vice versa).
    const regex = planTagEnvelopeRegex(tag);
    let match;
    while ((match = regex.exec(text)) !== null) {
      const content = match[1].trim();
      if (content) results.push({ tag, content });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Tool names that constitute a file write operation.
 * Includes both PascalCase (Claude Code, Cursor, Codex, Windsurf, Gemini) and
 * lowercase (opencode) variants. `patch` is opencode's unified-diff tool.
 */
const FILE_WRITE_TOOLS = new Set([
  'Write', 'Edit', 'Create',
  'write', 'edit', 'patch', 'create',
]);

/** Regex matching a top-level markdown heading (# Title). */
const HEADING_REGEX = /^#\s+(.+)$/m;

const TRANSCRIPT_SOURCE_TITLE_PREFIX = `${TRANSCRIPT_SOURCE_PREFIX}`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function resolvePlanWatchDir(watchDir: string, projectRoot: string): string {
  const expanded = watchDir.startsWith('~/')
    ? path.join(os.homedir(), watchDir.slice(2))
    : watchDir;
  return path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
}

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
    const absDir = resolvePlanWatchDir(dir, projectRoot);
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
  // `filePath` (camelCase) is opencode's convention — the plugin template ships
  // `input.args` through as `tool_input`, and opencode tools use camelCase args.
  const filePath = toolInput?.file_path ?? toolInput?.path ?? toolInput?.filePath;
  if (typeof filePath !== 'string') return null;
  if (!isInPlanDirectory(filePath, config.watchDirs, config.projectRoot)) return null;
  if (config.extensions?.length) {
    const ext = path.extname(filePath).toLowerCase();
    if (!config.extensions.includes(ext)) return null;
  }
  return filePath;
}

/**
 * The subset of a recorded activity needed to decide plan authorship.
 * Structurally compatible with `ActivityRow` from the activities query module.
 */
export interface PlanWriteActivity {
  tool_name: string;
  file_path: string | null;
  prompt_batch_id: number | null;
  timestamp: number;
}

/** A plan file a session authored, with the batch of its latest authoring write. */
export interface AuthoredPlanWrite {
  /**
   * Plan file path exactly as recorded on the authoring activity. The form
   * (absolute / relative / `./`-prefixed) is whatever the symbiont emitted;
   * downstream `capturePlan` canonicalizes it via `normalizePlanSourcePath`.
   */
  filePath: string;
  /** Prompt batch of the most-recent authoring write, for attribution. */
  promptBatchId: number | null;
}

/**
 * Select the plan files a session authored, from its recorded file activities.
 *
 * This is the retroactive half of the plan-capture authorship pattern: the live
 * `event-dispatch` path captures a plan when a write *event* fires; this reuses
 * the SAME `isPlanWriteEvent` predicate against already-recorded activities so a
 * stop-time reconcile can recover authored plans the live path missed — WITHOUT
 * the old mtime-window heuristic that claimed files a session never wrote.
 *
 * Authorship, not temporal proximity, is the association signal. A file is only
 * returned when this session has a plan-dir write activity for it. Per file, the
 * latest write wins (its `prompt_batch_id` is the attribution), so repeated
 * edits collapse to one capture. Symbiont-agnostic by construction — tool-name
 * and path-key variance is handled inside `isPlanWriteEvent`.
 */
export function selectAuthoredPlanWrites(
  activities: readonly PlanWriteActivity[],
  config: PlanWatchConfig,
): AuthoredPlanWrite[] {
  const latestByFile = new Map<string, { write: AuthoredPlanWrite; timestamp: number }>();
  for (const activity of activities) {
    const planFile = isPlanWriteEvent(
      activity.tool_name,
      { file_path: activity.file_path ?? undefined },
      config,
    );
    if (!planFile) continue;
    const existing = latestByFile.get(planFile);
    if (!existing || activity.timestamp >= existing.timestamp) {
      latestByFile.set(planFile, {
        write: { filePath: planFile, promptBatchId: activity.prompt_batch_id },
        timestamp: activity.timestamp,
      });
    }
  }
  return Array.from(latestByFile.values(), (entry) => entry.write);
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

function normalizePlanTags(tags?: string[] | string | null): string | null {
  if (tags === undefined || tags === null) return null;
  return Array.isArray(tags) ? tags.join(', ') : tags;
}

function fileTitleFromSourcePath(sourcePath?: string | null): string | null {
  if (!sourcePath || sourcePath.startsWith(TRANSCRIPT_SOURCE_TITLE_PREFIX)) return null;
  return path.basename(sourcePath);
}

export interface ResolvePlanTitleInput {
  content: string;
  title?: string | null;
  sourcePath?: string | null;
  planKey?: string | null;
}

export function resolvePlanTitle(input: ResolvePlanTitleInput): string | null {
  const explicitTitle = input.title?.trim();
  if (explicitTitle) return explicitTitle;

  const headingTitle = parsePlanTitle(input.content);
  if (headingTitle) return headingTitle;

  const sourcePathTitle = fileTitleFromSourcePath(input.sourcePath);
  if (sourcePathTitle) return sourcePathTitle;

  return input.planKey ? humanizePlanToken(input.planKey) : null;
}

export interface PersistPlanInput {
  id?: string;
  sessionId?: string | null;
  projectId?: string | null;
  content: string;
  logicalKey: string;
  sourcePath?: string | null;
  promptBatchId?: number | null;
  title?: string | null;
  status?: string;
  tags?: string[] | string | null;
  planKey?: string | null;
  createdAt?: number;
  updatedAt?: number | null;
  /** Optional logger for warn-level cross-channel overwrite detection. */
  logger?: Logger;
}

/**
 * Persist a plan, comparing content against the existing row on the same
 * logical_key.
 *
 * Behavior:
 *   - If an existing row matches the incoming content AND title, short-circuit
 *     and return the existing row unchanged. This avoids a redundant write and
 *     the accompanying team-sync enqueue when two channels (MCP + file
 *     reconciler) converge on the same logical_key with identical content.
 *   - If the content differs, the write proceeds (last-write-wins — same as
 *     before). When a logger is supplied and the source_path changed, emit a
 *     warn log so operators have forensic signal that two channels clobbered
 *     each other. A revisions table is a follow-up; this is the cheap guard.
 */
export function persistPlan(input: PersistPlanInput): PlanRow {
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1000);
  const updatedAt = input.updatedAt ?? createdAt;
  const contentHash = createHash(CONTENT_HASH_ALGORITHM).update(input.content).digest('hex');
  const projectId = input.projectId ?? null;
  const lookupScope: import('@myco/grove/ids.js').ProjectScope = projectId
    ? { kind: 'project', id: projectId as import('@myco/grove/ids.js').GroveProjectId }
    : { kind: 'global' };
  const existingPlan = getPlanByLogicalKey(input.logicalKey, lookupScope);
  const status = input.status ?? existingPlan?.status ?? 'active';
  const promptBatchId = input.promptBatchId === undefined
    ? (existingPlan?.prompt_batch_id ?? null)
    : input.promptBatchId;
  const tags = input.tags === undefined
    ? (existingPlan?.tags ?? null)
    : normalizePlanTags(input.tags);
  const resolvedTitle = resolvePlanTitle({
    content: input.content,
    title: input.title,
    sourcePath: input.sourcePath,
    planKey: input.planKey,
  });

  if (
    existingPlan
    && existingPlan.content_hash === contentHash
    && existingPlan.title === resolvedTitle
    && existingPlan.status === status
  ) {
    return existingPlan;
  }

  if (existingPlan && existingPlan.content_hash !== contentHash) {
    const priorSource = existingPlan.source_path ?? null;
    const newSource = input.sourcePath ?? null;
    if (priorSource !== newSource) {
      input.logger?.warn(LOG_KINDS.CAPTURE_PLAN, 'Plan overwritten mid-session', {
        logical_key: input.logicalKey,
        session_id: input.sessionId,
        prior_source: priorSource,
        new_source: newSource,
        prior_updated_at: existingPlan.updated_at,
      });
    }
  }

  return upsertPlan({
    id: input.id ?? buildScopedPlanId(input.logicalKey, projectId),
    project_id: projectId,
    logical_key: input.logicalKey,
    title: resolvedTitle,
    content: input.content,
    source_path: input.sourcePath ?? null,
    tags,
    session_id: input.sessionId ?? existingPlan?.session_id ?? null,
    prompt_batch_id: promptBatchId,
    content_hash: contentHash,
    status,
    created_at: createdAt,
    updated_at: updatedAt,
  });
}

/** Input to capturePlan. */
export interface CapturePlanInput {
  /** Absolute or relative path to the source plan file. */
  sourcePath: string;
  /** Project root used to canonicalize relative-vs-absolute file capture. */
  projectRoot?: string;
  /** Grove project scope for the captured row. */
  projectId?: string | null;
  /** Full markdown content of the plan file. */
  content: string;
  /** Session ID that triggered the write event. */
  sessionId: string;
  /** Optional prompt batch ID at the time of capture. */
  promptBatchId?: number | null;
  /** Optional logger forwarded to persistPlan for cross-channel overwrite detection. */
  logger?: Logger;
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
  const normalizedSourcePath = normalizePlanSourcePath(input.sourcePath, input.projectRoot);
  return persistPlan({
    sessionId: input.sessionId,
    projectId: input.projectId,
    content: input.content,
    logicalKey: buildFilePlanLogicalKey(input.sessionId, normalizedSourcePath),
    sourcePath: normalizedSourcePath,
    promptBatchId: input.promptBatchId,
    logger: input.logger,
  });
}

export interface CaptureTaggedPlanInput {
  tag: string;
  content: string;
  sessionId: string;
  projectId?: string | null;
  promptBatchId?: number | null;
  logger?: Logger;
}

export function captureTaggedPlan(input: CaptureTaggedPlanInput): PlanRow {
  return persistPlan({
    sessionId: input.sessionId,
    projectId: input.projectId,
    content: input.content,
    logicalKey: buildSessionTagPlanLogicalKey(input.sessionId, input.tag),
    sourcePath: `${TRANSCRIPT_SOURCE_PREFIX}${input.tag}`,
    promptBatchId: input.promptBatchId,
    planKey: input.tag,
    logger: input.logger,
  });
}
