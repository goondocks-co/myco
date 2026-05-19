/**
 * Stop-event processing pipeline.
 *
 * Extracted from daemon/main.ts. All logic for handling POST /events/stop lives
 * here: session auto-registration, transcript mining, batch reconciliation,
 * attachment capture, and title/summary agent task triggering.
 */

import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { TranscriptMiner, extractTurnsFromBuffer } from '@myco/capture/transcript-miner.js';
import type { TranscriptTurn } from '@myco/symbionts/adapter.js';
import type { GroveProjectId } from '@myco/grove/ids.js';
import { loadManifests } from '@myco/symbionts/detect.js';
import { gateEventByCaptureRules } from './capture-gating.js';
import { captureBatchImages } from './capture-images.js';
import {
  extractTaggedPlans,
  capturePlan,
  captureTaggedPlan,
  resolvePlanWatchDir,
} from './plan-capture.js';
import {
  getLatestBatch,
  getBatchById,
  setResponseSummary,
  populateBatchResponses,
  closeOpenBatches,
  listBatchesBySession,
  findBatchByPromptPrefix,
  type BatchRow,
} from '@myco/db/queries/batches.js';
import { deleteSessionCascade, getSession, updateSession } from '@myco/db/queries/sessions.js';
import { detectSkillUsage, SKILL_USAGE_DETECTION_ENABLED } from './skill-usage.js';
import { epochSeconds, LOG_MESSAGE_PREVIEW_CHARS } from '@myco/constants.js';
import { TITLE_PREVIEW_CHARS } from './event-handlers.js';
import { SessionRegistry } from './lifecycle.js';
import { ensureSession } from './session-lifecycle.js';
import { EventBuffer } from '@myco/capture/buffer.js';
import { DaemonLogger } from './logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { EmbeddingManager } from './embedding/index.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { triggerTitleSummary as sharedTriggerTitleSummary } from './trigger-title-summary.js';
import type { RouteHandler } from './router.js';
import type { RegisteredSession } from './lifecycle.js';
import { cleanupAfterSessionCascade } from './jobs/session-cleanup.js';
import type { PlanWatchConfig } from './plan-capture.js';
import { materializeCanopyAggregates } from '@myco/canopy/aggregate.js';
import { materializeSessionMycoToolCalls } from '@myco/db/queries/myco-tool-usage.js';
import { filesystemRootFromRequestContext, rowProjectIdFromRequestContext } from '@myco/tools/request-context.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import { deferGitProvenance } from '@myco/release-provenance/capture.js';
import { primaryProductionRef } from '@myco/release-provenance/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StopProcessorDeps {
  registry: SessionRegistry;
  sessionBuffers: Map<string, EventBuffer>;
  transcriptMiner: TranscriptMiner;
  embeddingManager: EmbeddingManager;
  logger: DaemonLogger;
  liveConfig: { current: MycoConfig };
  vaultDir: string;
  /** Daemon-resolved Grove project id used for every per-session insert. */
  projectId: GroveProjectId;
  machineId?: string;
  /** Plan tag names to extract from transcript responses. Merged from all symbiont manifests. */
  planTags: string[];
  planWatchConfig: PlanWatchConfig;
}

const MILLISECONDS_PER_SECOND = 1000;

function isEligiblePlanExtension(filePath: string, extensions?: string[]): boolean {
  if (!extensions || extensions.length === 0) return true;
  const extension = path.extname(filePath).toLowerCase();
  return extensions.includes(extension);
}

function collectPlanFiles(rootDir: string, extensions?: string[]): string[] {
  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (entry.isFile() && isEligiblePlanExtension(absolutePath, extensions)) {
        files.push(absolutePath);
      }
    }
  }

  return files;
}

function resolvePromptBatchIdForPlanWrite(
  batches: BatchRow[],
  modifiedAtSeconds: number,
): number | undefined {
  for (let index = batches.length - 1; index >= 0; index--) {
    const startedAt = batches[index].started_at;
    if (startedAt !== null && startedAt <= modifiedAtSeconds) {
      return batches[index].id;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Exported pure utility
// ---------------------------------------------------------------------------

/** Correlate buffer tool_use events with transcript turns by timestamp to populate toolBreakdown and files. */
export function enrichTurnsWithToolMetadata(turns: TranscriptTurn[], events: Array<Record<string, unknown>>): void {
  if (events.length === 0 || turns.length === 0) return;

  const toolEvents = events.filter((e) => e.type === 'tool_use');
  if (toolEvents.length === 0) return;

  let cursor = 0;
  for (let i = 0; i < turns.length; i++) {
    const turnEnd = i + 1 < turns.length ? turns[i + 1].timestamp : null;
    const breakdown: Record<string, number> = {};
    const files = new Set<string>();

    while (cursor < toolEvents.length) {
      const ts = String(toolEvents[cursor].timestamp ?? '');
      if (turnEnd !== null && ts >= turnEnd) break;
      const evt = toolEvents[cursor];
      const toolName = String(evt.tool_name ?? evt.tool ?? 'unknown');
      breakdown[toolName] = (breakdown[toolName] ?? 0) + 1;
      const input = evt.tool_input as Record<string, unknown> | undefined;
      const filePath = input?.file_path ?? input?.path;
      if (typeof filePath === 'string') files.add(filePath);
      cursor++;
    }

    if (Object.keys(breakdown).length > 0) {
      turns[i].toolBreakdown = breakdown;
      if (files.size > 0) turns[i].files = [...files];
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStopProcessor(deps: StopProcessorDeps): {
  handleStopRoute: RouteHandler;
  clearSession: (sessionId: string) => void;
  getActiveProcessing: () => Promise<void> | null;
  triggerTitleSummary: (sessionId: string) => Promise<void>;
} {
  const {
    registry,
    sessionBuffers,
    transcriptMiner,
    embeddingManager,
    logger,
    liveConfig,
    vaultDir,
    projectId: defaultProjectId,
    machineId = 'local',
    planWatchConfig,
  } = deps;

  function configForRequest(req: Parameters<RouteHandler>[0]): MycoConfig {
    const ctx = req.requestContext;
    if (!ctx?.projectVaultDir || !ctx.groveId) return liveConfig.current;
    try {
      return loadMergedConfig(ctx.projectVaultDir, { groveId: ctx.groveId });
    } catch {
      return liveConfig.current;
    }
  }

  // Internal state
  let activeStopProcessing: Promise<void> | null = null;
  const sessionTitleCache = new Map<string, string>();

  // Route body schema.
  //
  // `transcript_path` is nullish (missing, undefined, or literal `null`)
  // because some symbionts fire Stop hooks for internal sub-invocations
  // that never write a transcript — notably Codex's title-generation
  // ephemeral session. The SessionStart capture-rule filter already
  // skips registering such sessions, so a null transcript_path here
  // means "Stop for a session we never captured." The handler treats
  // that case as a silent no-op rather than erroring.
  const StopBody = z.object({
    session_id: z.string(),
    agent: z.string().optional(),
    user: z.string().optional(),
    transcript_path: z.string().nullish(),
    last_assistant_message: z.string().nullish(),
  });

  const triggerTitleSummary = (sessionId: string) =>
    sharedTriggerTitleSummary(sessionId, { vaultDir, embeddingManager, liveConfig, logger });

  function cleanupInvalidCapturedSession(sessionId: string): boolean {
    registry.unregister(sessionId);
    sessionBuffers.delete(sessionId);
    sessionTitleCache.delete(sessionId);

    const result = deleteSessionCascade(sessionId);
    if (!result.deleted) return false;

    cleanupAfterSessionCascade(sessionId, result, embeddingManager, vaultDir).catch(() => {});
    return true;
  }

  /**
   * Walk parent pointers up to the first non-steering batch so the response
   * summary lands on the turn's owning prompt card. Steering children never
   * themselves become parents (see handleUserPrompt), so a single hop is the
   * expected depth; the loop survives an unexpected multi-hop chain anyway.
   */
  function findOwningParent(child: BatchRow): BatchRow | null {
    let current: BatchRow | null = child;
    while (current?.parent_prompt_batch_id != null) {
      const parent = getBatchById(current.parent_prompt_batch_id, ALL_PROJECTS_SCOPE);
      if (!parent || parent.id === current.id) break;
      current = parent;
    }
    return current;
  }

  async function processStopEvent(
    sessionId: string,
    user: string | undefined,
    sessionMeta: RegisteredSession | undefined,
    requestProjectId: GroveProjectId,
    requestRowProjectId: string | null,
    requestProjectRoot: string,
    requestFilesystemRoot: string,
    requestMachineId: string,
    requestProductionRef: string | null,
    hookTranscriptPath?: string,
    lastAssistantMessage?: string,
  ): Promise<void> {

    // --- Phase 1: Gather transcript data ---

    const transcriptResult = transcriptMiner.getAllTurnsWithSource(sessionId, hookTranscriptPath);
    let allTurns = transcriptResult.turns;
    let turnSource = transcriptResult.source;

    const bufferEvents = sessionBuffers.get(sessionId)?.readAll() ?? [];

    if (allTurns.length === 0) {
      allTurns = extractTurnsFromBuffer(bufferEvents);
      turnSource = 'buffer';
    } else if (bufferEvents.length > 0) {
      const lastTranscriptTs = allTurns[allTurns.length - 1].timestamp;
      if (lastTranscriptTs) {
        const newerEvents = bufferEvents.filter((e) =>
          String(e.timestamp ?? '') > lastTranscriptTs,
        );
        if (newerEvents.length > 0) {
          const bufferTurns = extractTurnsFromBuffer(newerEvents);
          allTurns = [...allTurns, ...bufferTurns];
          turnSource = `${transcriptResult.source}+buffer`;
          logger.info(LOG_KINDS.PROCESSOR_TRANSCRIPT, 'Appended buffer turns missing from transcript', {
            session_id: sessionId, transcriptTurns: transcriptResult.turns.length, bufferTurns: bufferTurns.length,
          });
        }
      }
    }

    // Attach the last assistant message from the hook to the most recent turn
    if (lastAssistantMessage && allTurns.length > 0) {
      const lastTurn = allTurns[allTurns.length - 1];
      if (!lastTurn.aiResponse) {
        lastTurn.aiResponse = lastAssistantMessage;
      }
    }

    enrichTurnsWithToolMetadata(allTurns, bufferEvents);

    // Reconcile batch kinds against the transcript now that we have a stable
    // transcript path. This repairs any hook-race misclassifications (e.g.,
    // two consecutive initial batches where the second should be steering).
    if (hookTranscriptPath) {
      const agent = getSession(sessionId, ALL_PROJECTS_SCOPE)?.agent;
      if (agent) {
        try {
          transcriptMiner.reconcileBatchKinds(sessionId, { agent, transcriptPath: hookTranscriptPath });
        } catch (err) {
          logger.warn(LOG_KINDS.PROCESSOR_TRANSCRIPT, 'reconcileBatchKinds failed', {
            session_id: sessionId,
            error: (err as Error).message,
          });
        }
      }
    }

    const imageCount = allTurns.reduce((sum, t) => sum + (t.images?.length ?? 0), 0);
    logger.debug(LOG_KINDS.PROCESSOR_TRANSCRIPT, 'Transcript parsed', {
      session_id: sessionId,
      turn_count: allTurns.length,
      image_count: imageCount,
    });

    // --- Phase 2: Capture response + close session ---

    // Get the latest batch BEFORE closing — this is the batch for the current turn.
    const latestBatch = getLatestBatch(sessionId);

    // Primary capture: put last_assistant_message on the TURN'S batch, not
    // just the most recently inserted one. When a steering child nests under
    // its parent, both batches belong to the same turn — there's only one
    // combined assistant response, and it belongs on the parent so the UI's
    // parent card renders it. The steering child's summary stays null
    // (steering children never carry a response of their own).
    // Fall back to the last parsed turn's aiResponse when the symbiont's stop
    // payload omits `last_assistant_message` (e.g., Cursor), or when only the
    // transcript carries the final text. Covers Cursor's per-turn transcript
    // model, where the file is rewritten each turn and only contains the
    // current one — we always want that single turn's response on the latest
    // batch, regardless of prompt_number alignment.
    const latestTurnResponse = allTurns.length > 0 ? allTurns[allTurns.length - 1]?.aiResponse : undefined;
    const resolvedResponse = lastAssistantMessage || latestTurnResponse;
    if (resolvedResponse && latestBatch && !latestBatch.response_summary) {
      const summaryTarget = latestBatch.parent_prompt_batch_id
        ? findOwningParent(latestBatch)
        : latestBatch;
      if (summaryTarget && !summaryTarget.response_summary) {
        try { setResponseSummary(summaryTarget.id, resolvedResponse); }
        catch (err) { logger.warn(LOG_KINDS.PROCESSOR_BATCH, 'Failed to set response_summary on latest batch', { error: String(err) }); }
      }
    }

    // Close open batches but do NOT close the session — the Stop hook fires
    // after every assistant turn, not just session end. The session is closed
    // when the SessionEnd hook fires (via /sessions/unregister).
    closeOpenBatches(sessionId, epochSeconds());
    if (latestBatch) {
      deferGitProvenance({
        projectRoot: requestProjectRoot,
        projectId: requestRowProjectId,
        machineId: requestMachineId,
        sessionId,
        promptBatchId: latestBatch.id,
        capturePoint: 'prompt_batch_stop',
        productionRef: requestProductionRef,
        logger,
      });
    }

    // Derive a simple title from the first user prompt — but only if the
    // session has no title yet. Once the LLM (or anything else) sets a title,
    // stop overwriting it with the fallback.
    const existingSession = getSession(sessionId, ALL_PROJECTS_SCOPE);
    const hasTitle = existingSession?.title !== null && existingSession?.title !== undefined;

    if (!hasTitle) {
      let title = sessionTitleCache.get(sessionId) ?? null;
      if (!title) {
        const firstBatch = listBatchesBySession(sessionId, { limit: 1, scope: ALL_PROJECTS_SCOPE })[0];
        if (firstBatch?.user_prompt) {
          title = firstBatch.user_prompt.slice(0, TITLE_PREVIEW_CHARS);
          if (firstBatch.user_prompt.length > TITLE_PREVIEW_CHARS) {
            title += '...';
          }
          sessionTitleCache.set(sessionId, title);
        }
      }
    }

    // Update session with transcript metadata (no LLM calls).
    // Use MAX of current DB count vs transcript-derived count — the incremental
    // count from handleUserPrompt is authoritative during active sessions; the
    // transcript parse may see fewer turns if the file is incomplete.
    const currentSession = getSession(sessionId, ALL_PROJECTS_SCOPE);
    const transcriptPromptCount = allTurns.length;
    const transcriptToolCount = allTurns.reduce((sum, t) => sum + t.toolCount, 0);

    const updateFields: Record<string, unknown> = {
      transcript_path: hookTranscriptPath ?? null,
      prompt_count: Math.max(transcriptPromptCount, currentSession?.prompt_count ?? 0),
      tool_count: Math.max(transcriptToolCount, currentSession?.tool_count ?? 0),
    };
    if (user) updateFields.user = user;
    if (!hasTitle && sessionTitleCache.has(sessionId)) {
      updateFields.title = sessionTitleCache.get(sessionId);
    }

    updateSession(sessionId, updateFields as Parameters<typeof updateSession>[1], ALL_PROJECTS_SCOPE);

    // Detect skill usage from transcript content (best-effort, non-blocking).
    // Skip transcript I/O entirely when detection is disabled.
    if (SKILL_USAGE_DETECTION_ENABLED) {
      try {
        let transcriptText: string | null = null;
        if (hookTranscriptPath) {
          try { transcriptText = fs.readFileSync(hookTranscriptPath, 'utf-8'); }
          catch { /* file may not exist yet — fall through */ }
        }
        if (!transcriptText && allTurns.length > 0) {
          transcriptText = allTurns
            .map((t) => [t.prompt ?? '', t.aiResponse ?? ''].join(' '))
            .join('\n');
        }
        if (transcriptText) {
          detectSkillUsage(sessionId, transcriptText, requestProjectId);
        }
      } catch {
        // Best-effort — don't block reconciliation
      }
    }

    // Match transcript turns to batches by prompt-text prefix so earlier
    // batches get their response_summary filled even when the transcript's
    // turn order doesn't align with batch insertion order (Cursor starts its
    // transcript mid-session, daemon restarts renumber prompts, etc.).
    const transcriptResponses = allTurns
      .filter((t) => t.prompt && t.aiResponse)
      .map((t) => ({ prompt: t.prompt, response: t.aiResponse! }));
    if (transcriptResponses.length > 0) {
      try { populateBatchResponses(sessionId, transcriptResponses); }
      catch (err) { logger.warn(LOG_KINDS.PROCESSOR_BATCH, 'Failed to populate batch responses', { error: String(err) }); }
    }

    // --- Plan tag extraction from transcript responses ---
    if (deps.planTags.length > 0) {
      for (const turn of allTurns) {
        if (!turn.aiResponse) continue;
        const taggedPlans = extractTaggedPlans(turn.aiResponse, deps.planTags);
        for (const { tag, content } of taggedPlans) {
          try {
            captureTaggedPlan({
              tag,
              content,
              sessionId,
              projectId: requestRowProjectId,
              promptBatchId: latestBatch?.id ?? null,
              logger,
            });
            logger.info(LOG_KINDS.CAPTURE_PLAN, 'Plan captured from transcript tag', {
              session_id: sessionId,
              tag,
              content_length: content.length,
            });
          } catch (err) {
            logger.warn(LOG_KINDS.CAPTURE_PLAN, 'Failed to capture plan from transcript tag', {
              session_id: sessionId,
              tag,
              error: (err as Error).message,
            });
          }
        }
      }
    }

    const sessionStartedAt = currentSession?.started_at
      ?? (sessionMeta?.started_at
        ? Math.floor(new Date(sessionMeta.started_at).getTime() / MILLISECONDS_PER_SECOND)
        : epochSeconds());
    // File mtime on APFS has sub-millisecond precision but Date.now() rounds
    // to whole ms. A plan file written in the same ms as the Stop event can
    // end up with mtimeMs > Date.now() by a fraction. Quantize mtime to
    // integer ms so the boundary check is stable across filesystems.
    const sessionStopMs = Date.now();
    const sessionBatches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });

    const planCaptureRoot = requestFilesystemRoot;
    for (const watchDir of planWatchConfig.watchDirs) {
      const absoluteWatchDir = resolvePlanWatchDir(watchDir, planCaptureRoot);
      if (!fs.existsSync(absoluteWatchDir)) continue;

      const planFiles = collectPlanFiles(absoluteWatchDir, planWatchConfig.extensions);
      for (const planFile of planFiles) {
        let stats: fs.Stats;
        try {
          stats = fs.statSync(planFile);
        } catch {
          continue;
        }
        const mtimeMs = Math.floor(stats.mtimeMs);
        if (mtimeMs < sessionStartedAt * MILLISECONDS_PER_SECOND || mtimeMs > sessionStopMs) {
          continue;
        }

        try {
          const content = fs.readFileSync(planFile, 'utf-8');
          const promptBatchId = resolvePromptBatchIdForPlanWrite(
            sessionBatches,
            Math.floor(stats.mtimeMs / MILLISECONDS_PER_SECOND),
          );
          capturePlan({
            sourcePath: planFile,
            projectRoot: planCaptureRoot,
            projectId: requestRowProjectId,
            content,
            sessionId,
            promptBatchId,
            logger,
          });
          logger.info(LOG_KINDS.CAPTURE_PLAN, 'Plan reconciled from configured plan dir', {
            session_id: sessionId,
            source_path: planFile,
          });
        } catch (err) {
          logger.warn(LOG_KINDS.CAPTURE_PLAN, 'Failed to reconcile plan from configured plan dir', {
            session_id: sessionId,
            source_path: planFile,
            error: (err as Error).message,
          });
        }
      }
    }

    // Trigger title/summary if the session still needs one.
    if (!hasTitle) {
      triggerTitleSummary(sessionId);
    }

    // Write images to attachments — decoupled from transcript turn indices.
    // After context compaction, transcript turn indices no longer match batch prompt_numbers.
    // Instead, match each turn to its batch by prompt text (content-based, not position-based).
    // Binary data is stored in the DB BLOB column; DB uses ON CONFLICT DO NOTHING → idempotent.
    for (let i = 0; i < allTurns.length; i++) {
      const turn = allTurns[i];
      if (!turn.images?.length) continue;

      // Resolve which batch this turn belongs to:
      // 1. Last turn → use latestBatch (always correct, comes from the current stop event)
      // 2. Earlier turns → match by prompt text prefix against DB
      // 3. Fallback → null batch_id (still saved, UI matches by filename pattern)
      const isLastTurn = i === allTurns.length - 1;
      let resolvedBatchId: number | null = null;
      let resolvedPromptNumber: number = i + 1; // default to turn index (pre-compaction compatible)

      if (isLastTurn && latestBatch) {
        resolvedBatchId = latestBatch.id;
        resolvedPromptNumber = latestBatch.prompt_number ?? resolvedPromptNumber;
      } else if (turn.prompt) {
        try {
          const match = findBatchByPromptPrefix(sessionId, turn.prompt);
          if (match) {
            resolvedBatchId = match.id;
            resolvedPromptNumber = match.prompt_number;
          }
        } catch { /* fallback to index-based */ }
      }

      captureBatchImages({
        sessionId,
        promptBatchId: resolvedBatchId,
        promptNumber: resolvedPromptNumber,
        images: turn.images,
        logger,
        projectId: requestProjectId,
      });
    }

    logger.info(LOG_KINDS.PROCESSOR_SESSION, 'Session captured', {
      session_id: sessionId,
      turns: allTurns.length,
      source: turnSource,
      title: existingSession?.title ?? sessionTitleCache.get(sessionId) ?? '(untitled)',
    });

    // Materialize Canopy aggregates onto the sessions row. Pure SQL over
    // already-persisted activities — safe to run after every Stop. Internal
    // failure is swallowed by materializeCanopyAggregates so it never blocks
    // the rest of the Stop pipeline.
    materializeCanopyAggregates(sessionId);

    // Materialize per-(tool, op) Myco tool-call counts into
    // `session_myco_tool_calls`. Same pattern: pure SQL over the activity
    // log, internal failures swallowed. Replaces the dispatch-time
    // `canopy_map_tool_calls` counter that depended on a transport-supplied
    // sessionId and silently produced zeros for several symbionts.
    materializeSessionMycoToolCalls(sessionId);
  }

  const handleStopRoute: RouteHandler = async (req) => {
    const {
      session_id: sessionId,
      agent,
      user,
      transcript_path: hookTranscriptPath,
      last_assistant_message: lastAssistantMessage,
    } = StopBody.parse(req.body);
    const requestProjectId = req.requestContext?.projectId ?? defaultProjectId;
    const requestScope = rowProjectIdFromRequestContext(req.requestContext);
    const requestRowProjectId = requestScope === undefined ? requestProjectId : requestScope;
    const requestProjectRoot = req.requestContext?.projectRoot ?? resolveProjectRoot(vaultDir);
    const requestFilesystemRoot = req.requestContext
      ? filesystemRootFromRequestContext(req.requestContext)
      : planWatchConfig.projectRoot;
    const requestMachineId = req.requestContext?.machineId ?? machineId;
    const requestProductionRef = primaryProductionRef(configForRequest(req));

    if (hookTranscriptPath) {
      const detectedAgent = agent ?? getSession(sessionId, ALL_PROJECTS_SCOPE)?.agent ?? 'claude-code';
      const { decision } = gateEventByCaptureRules(
        { agent: detectedAgent, transcriptPath: hookTranscriptPath },
        { manifests: loadManifests() },
      );
      if (decision.action === 'drop') {
        const deleted = cleanupInvalidCapturedSession(sessionId);
        logger.info(LOG_KINDS.HOOKS_STOP, 'Stop ignored — invalid captured session', {
          session_id: sessionId,
          reason: decision.reason ?? 'rule',
          deleted_existing_session: deleted,
        });
        return { body: { ok: true, ignored: decision.reason ?? 'rule' } };
      }
    }

    // Ephemeral sub-invocation guard.
    //
    // When Codex (or a similar agent) spawns an internal sub-invocation
    // that never writes a transcript — e.g., its title-generation call —
    // the sub-invocation's Stop hook fires with transcript_path=null.
    // The SessionStart capture-rule filter already skips registering
    // that session_id, so at this point we have no session row and no
    // meaningful Stop to process. Silently no-op rather than auto-
    // registering a row we then have nothing to update.
    //
    // A DB row for this session means it was previously registered, so the
    // Stop is legitimate even when the in-memory registry missed it after a
    // daemon restart — rehydrate before falling through to the phantom drop.
    const existingSessionMeta = registry.getSession(sessionId);
    const dbSession = existingSessionMeta ? undefined : getSession(sessionId, ALL_PROJECTS_SCOPE);
    if (!hookTranscriptPath && !existingSessionMeta && !dbSession) {
      // Info level so `grep hooks.stop` in the default daemon log confirms
      // the ephemeral-sub-invocation drop pattern is firing without
      // needing to crank the log level. Codex's sub-invocation behavior
      // is experimental upstream and may change over time — this log is
      // the signal we'd watch if the pattern needed revisiting.
      logger.info(LOG_KINDS.HOOKS_STOP, 'Stop ignored — ephemeral sub-invocation', {
        session_id: sessionId,
      });
      return { body: { ok: true, ignored: 'ephemeral-sub-invocation' } };
    }

    // Ensure session is registered (handles daemon restarts mid-session
    // AND the Codex-style case where the very first event we see for a
    // session is a Stop, not a user_prompt). Pre-fix, this path only
    // updated the in-memory registry — the missing DB row produced silent
    // FK cascades in every subsequent prompt_batch/activity insert. Go
    // through the lifecycle helper so the row exists by construction.
    if (!existingSessionMeta) {
      if (dbSession) {
        // Cheap rehydrate path: row already exists, just cache it.
        registry.register(sessionId, { started_at: new Date().toISOString() });
        logger.debug(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'Rehydrated registry from DB on stop event', {
          session_id: sessionId,
        });
      } else {
        // First-sight session — Stop is its registration event. Persist
        // the row before adding to the registry so future prompt/tool
        // events find an existing sessions.id when they reference it via
        // FK. `agent` is best-effort: hook events for Codex / Claude
        // include it; older transcripts may not.
        ensureSession({
          sessionId,
          agent: agent ?? 'claude-code',
          projectId: requestRowProjectId ?? null,
          projectRoot: requestProjectRoot,
          machineId: requestMachineId,
          startedAt: new Date().toISOString(),
          registry,
          logger,
          source: 'stop',
        });
        logger.debug(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'Auto-registered session from stop event', {
          session_id: sessionId,
        });
      }
    }
    const sessionMeta = existingSessionMeta ?? registry.getSession(sessionId);
    logger.info(LOG_KINDS.HOOKS_STOP, 'Stop received', {
      session_id: sessionId,
      has_transcript_path: !!hookTranscriptPath,
      has_response: !!lastAssistantMessage,
    });
    logger.debug(LOG_KINDS.HOOKS_STOP, 'Stop event detail', {
      session_id: sessionId,
      transcript_path: hookTranscriptPath ?? null,
      last_message_preview: lastAssistantMessage?.slice(0, LOG_MESSAGE_PREVIEW_CHARS) ?? null,
    });

    // Respond immediately — the hook should not block on processing.
    // Normalize nullish hook fields to undefined so downstream processStopEvent
    // keeps its existing `string | undefined` contract (the schema accepts
    // `nullish()` for robustness against ephemeral sub-invocation Stop events).
    const normalizedTranscriptPath = hookTranscriptPath ?? undefined;
    const normalizedAssistantMessage = lastAssistantMessage ?? undefined;
    const run = () => processStopEvent(
      sessionId,
      user,
      sessionMeta,
      requestProjectId,
      requestRowProjectId,
      requestProjectRoot,
      requestFilesystemRoot,
      requestMachineId,
      requestProductionRef,
      normalizedTranscriptPath,
      normalizedAssistantMessage,
    ).catch((err) => {
      logger.error(LOG_KINDS.PROCESSOR_SESSION, 'Stop processing failed', { session_id: sessionId, error: (err as Error).message });
    });

    const prev = activeStopProcessing ?? Promise.resolve();
    activeStopProcessing = prev.then(run).finally(() => { activeStopProcessing = null; });

    return { body: { ok: true } };
  };

  return {
    handleStopRoute,
    clearSession: (sessionId: string) => { sessionTitleCache.delete(sessionId); },
    getActiveProcessing: () => activeStopProcessing,
    triggerTitleSummary,
  };
}
