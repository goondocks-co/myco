/**
 * Event dispatch factory for the Myco daemon.
 *
 * Extracted from daemon/main.ts. All logic for handling POST /events lives
 * here: session auto-registration, buffer persistence, and the full
 * if/else dispatch chain for all event types.
 */

import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import type { RouteHandler } from './router.js';
import { SessionRegistry } from './lifecycle.js';
import { EventBuffer } from '@myco/capture/buffer.js';
import { PowerManager } from './power.js';
import { DaemonLogger } from './logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { PlanWatchConfig } from './plan-capture.js';
import {
  isPlanWriteEvent,
  capturePlan,
  captureTaggedPlan,
  extractTaggedPlans,
} from './plan-capture.js';
import {
  isSystemMessage,
  handleUserPrompt,
  handleToolUse,
  handleToolFailure,
  handleSubagentStart,
  handleSubagentStop,
  handleStopFailure,
  handleTaskCompleted,
  handleCompact,
} from './event-handlers.js';
import { getLatestBatch } from '@myco/db/queries/batches.js';
import { getSession, upsertSession, reactivateSessionIfCompleted } from '@myco/db/queries/sessions.js';
import { captureBatchImages, type CapturedImage } from './capture-images.js';
import { DEFAULT_SYMBIONT_NAME, epochSeconds, LOG_PROMPT_PREVIEW_CHARS } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { loadManifests } from '@myco/symbionts/detect.js';
import { gateEventByCaptureRules } from './capture-gating.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const EventBody = z.object({ type: z.string(), session_id: z.string() }).passthrough();

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface EventDispatchDeps {
  registry: SessionRegistry;
  sessionBuffers: Map<string, EventBuffer>;
  powerManager: PowerManager;
  logger: DaemonLogger;
  machineId: string;
  // Holder so summary_batch_interval is read fresh on each user_prompt event —
  // changing the interval in Settings takes effect on the very next prompt.
  liveConfig: { current: MycoConfig };
  vaultDir: string;
  reconcileSession: (sessionId: string) => void;
  planWatchConfig: PlanWatchConfig; // object reference — mutated in place for hot-reload
  triggerTitleSummary: (sessionId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// Cap dropped-session cache to bound memory. Dropped sessions are rarely
// revisited; FIFO eviction via Map ordering is sufficient.
const DROP_DECISION_CACHE_MAX = 1024;

export function createEventDispatcher(deps: EventDispatchDeps): RouteHandler {
  const {
    registry,
    sessionBuffers,
    powerManager,
    logger,
    machineId,
    liveConfig,
    vaultDir: vaultDir,
    reconcileSession,
    planWatchConfig,
    triggerTitleSummary,
  } = deps;

  const projectRoot = process.cwd();
  const manifests = loadManifests();
  const planTagsByAgent = new Map(
    manifests.map((manifest) => [manifest.name, manifest.capture?.planTags ?? []] as const),
  );

  // Cache drop decisions by session_id so a rejected session that keeps firing
  // events doesn't re-open + re-read (up to 128 KB) its transcript every time.
  // Cache: sessionId → { reason, hadTranscriptMeta }. When an incoming event
  // newly supplies a transcript_path but the cached decision was made with
  // `transcriptMeta: undefined`, we re-evaluate once — a transcript showing
  // up mid-session can flip the capture rules in the "accept" direction.
  const droppedSessions = new Map<string, { reason: string | undefined; hadTranscriptMeta: boolean }>();

  function rememberDropped(sessionId: string, reason: string | undefined, hadTranscriptMeta: boolean): void {
    if (droppedSessions.size >= DROP_DECISION_CACHE_MAX) {
      const oldest = droppedSessions.keys().next().value;
      if (oldest !== undefined) droppedSessions.delete(oldest);
    }
    droppedSessions.set(sessionId, { reason, hadTranscriptMeta });
  }

  function evaluateAutoRegistration(event: Record<string, unknown>): {
    decision: { action: 'pass' } | { action: 'drop'; reason?: string };
    hadTranscriptMeta: boolean;
  } {
    const transcriptPath = typeof event.transcript_path === 'string' && event.transcript_path.length > 0
      ? event.transcript_path
      : undefined;
    const detectedAgent = typeof event.agent === 'string' ? event.agent : DEFAULT_SYMBIONT_NAME;

    // Fail open: a manifest with a bad regex or schema error must not
    // wedge the dispatcher and drop every subsequent event. The individual
    // data-preservation contract is "capture by default" — keeping a noisy
    // session is recoverable; dropping every event until restart is not.
    try {
      return gateEventByCaptureRules(
        { agent: detectedAgent, transcriptPath },
        { manifests },
      );
    } catch (err) {
      logger.error(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'Capture-rules evaluator threw', {
        error: String(err),
        session_id: typeof event.session_id === 'string' ? event.session_id : undefined,
        agent: detectedAgent,
      });
      return { decision: { action: 'pass' }, hadTranscriptMeta: false };
    }
  }

  function getPlanTagsForAgent(agent: unknown): string[] {
    const agentName = typeof agent === 'string' && agent.length > 0 ? agent : DEFAULT_SYMBIONT_NAME;
    return planTagsByAgent.get(agentName) ?? [];
  }

  return async (req) => {
    const validated = EventBody.parse(req.body);
    const event = {
      ...validated,
      timestamp: (validated as Record<string, unknown>).timestamp ?? new Date().toISOString(),
    } as Record<string, unknown> & { type: string; session_id: string; timestamp: string };

    logger.debug(LOG_KINDS.HOOKS_EVENT, 'Event received', { type: event.type, session_id: event.session_id });

    // Ensure session is registered (idempotent — handles daemon restarts mid-session)
    if (!registry.getSession(event.session_id)) {
      // Rehydrate from SQLite before running capture rules. A session row
      // means we already admitted this session (on a prior run or earlier in
      // this run); re-gating it risks applying phantom-detection rules to a
      // legitimate mid-flight session whose in-memory registry was lost on
      // daemon restart. The capture gate is for first-sight sessions only.
      const existingRow = getSession(event.session_id);
      if (existingRow) {
        registry.register(event.session_id, { started_at: event.timestamp });
        logger.info(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'Rehydrated registry from DB', {
          session_id: event.session_id,
          agent: existingRow.agent,
          type: event.type,
        });
        reconcileSession(event.session_id);
      } else {
        const cached = droppedSessions.get(event.session_id);
        const hasTranscriptNow = typeof event.transcript_path === 'string' && event.transcript_path.length > 0;
        // Re-evaluate when a previously-unattended session newly supplies a
        // transcript_path — the earlier drop was made without transcript meta.
        const shouldReevaluate = cached && !cached.hadTranscriptMeta && hasTranscriptNow;
        if (cached && !shouldReevaluate) {
          const reason = cached.reason ?? 'rule';
          logger.debug(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'Ignored event for previously-dropped session', {
            session_id: event.session_id,
            type: event.type,
            reason,
          });
          return { body: { ok: true, ignored: reason } };
        }
        if (shouldReevaluate) {
          droppedSessions.delete(event.session_id);
        }
        const { decision, hadTranscriptMeta } = evaluateAutoRegistration(event);
        if (decision.action === 'drop') {
          rememberDropped(event.session_id, decision.reason, hadTranscriptMeta);
          logger.info(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'Ignored event that failed session capture rules', {
            session_id: event.session_id,
            type: event.type,
            reason: decision.reason ?? 'rule',
          });
          return { body: { ok: true, ignored: decision.reason ?? 'rule' } };
        }

        registry.register(event.session_id, { started_at: event.timestamp });
        logger.debug(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'Auto-registered session from event', { session_id: event.session_id });

        // Ensure SQLite session exists — explicitly set status='active' so
        // resumed sessions (previously 'completed') get reopened.
        const now = epochSeconds();
        const startedEpoch = Math.floor(new Date(event.timestamp).getTime() / 1000);
        upsertSession({
          id: event.session_id,
          agent: (event as Record<string, unknown>).agent as string ?? DEFAULT_SYMBIONT_NAME,
          status: 'active',
          started_at: startedEpoch,
          created_at: now,
          machine_id: machineId,
        });

        // Reconcile buffer against DB — recover any prompts lost during downtime.
        reconcileSession(event.session_id);
      }
    }

    // Persist to disk so events survive daemon restarts
    if (!sessionBuffers.has(event.session_id)) {
      const bufferDir = path.join(vaultDir, 'buffer');
      sessionBuffers.set(event.session_id, new EventBuffer(bufferDir, event.session_id));
    }
    sessionBuffers.get(event.session_id)!.append(event);

    // --- Prompt batch tracking ---
    if (event.type === 'user_prompt') {
      powerManager.recordActivity();
      const promptText = String(event.prompt ?? '');

      // Skip system-injected messages (task notifications, system reminders) —
      // they trigger UserPromptSubmit but are not real user prompts.
      if (isSystemMessage(promptText)) {
        logger.debug(LOG_KINDS.HOOKS_PROMPT, 'Skipped system-injected message', {
          session_id: event.session_id,
          prefix: promptText.trimStart().slice(0, LOG_PROMPT_PREVIEW_CHARS),
        });
      } else {
        logger.info(LOG_KINDS.HOOKS_PROMPT, 'User prompt received', {
          session_id: event.session_id,
          prompt_preview: promptText.slice(0, LOG_PROMPT_PREVIEW_CHARS),
          prompt_length: promptText.length,
        });
        // Flip a completed session back to active on genuine user activity.
        // The auto-register branch above only reactivates when the session
        // isn't in the in-memory registry (e.g., after daemon restart) —
        // without this, a manually-completed or stale-swept session stays
        // hidden from intelligence-task queries even after the user resumes.
        if (reactivateSessionIfCompleted(event.session_id)) {
          logger.info(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'Reactivated completed session on new activity', {
            session_id: event.session_id,
          });
        }
        try {
          const { batchId, promptNumber } = handleUserPrompt(event.session_id, promptText || undefined);
          logger.debug(LOG_KINDS.CAPTURE_BATCH, 'Batch opened', { session_id: event.session_id, batch_id: batchId, prompt_number: promptNumber });

          const taggedPlans = extractTaggedPlans(promptText, getPlanTagsForAgent(event.agent));
          for (const { tag, content } of taggedPlans) {
            try {
              captureTaggedPlan({
                tag,
                content,
                sessionId: event.session_id,
                promptBatchId: batchId,
                logger,
              });
              logger.info(LOG_KINDS.CAPTURE_PLAN, 'Plan captured from prompt tag', {
                session_id: event.session_id,
                tag,
                content_length: content.length,
              });
            } catch (err) {
              logger.warn(LOG_KINDS.CAPTURE_PLAN, 'Failed to capture plan from prompt tag', {
                session_id: event.session_id,
                tag,
                error: (err as Error).message,
              });
            }
          }

          // Plugin-based symbionts (opencode) ship image attachments in the
          // user_prompt event payload rather than in an on-disk transcript.
          // The stop-event transcript-mining path handles claude-code/cursor;
          // the persistence logic is shared between both paths via
          // captureBatchImages.
          const eventImages = event.images as CapturedImage[] | undefined;
          if (Array.isArray(eventImages) && eventImages.length > 0) {
            captureBatchImages({
              sessionId: event.session_id,
              promptBatchId: batchId,
              promptNumber,
              images: eventImages,
              logger,
            });
          }

          // Batch-threshold summary trigger
          const batchCount = promptNumber;
          const summaryInterval = liveConfig.current.agent.summary_batch_interval;
          if (summaryInterval > 0 && batchCount > 0 && batchCount % summaryInterval === 0) {
            triggerTitleSummary(event.session_id);
          }
        } catch (err) {
          logger.warn(LOG_KINDS.CAPTURE_BATCH, 'Failed to open batch', { session_id: event.session_id, error: (err as Error).message });
        }
      }
    }

    if (event.type === 'tool_use') {
      const toolName = String(event.tool_name ?? '');
      logger.debug(LOG_KINDS.HOOKS_TOOL, 'Tool use event', {
        session_id: event.session_id,
        tool_name: toolName,
      });
      // Plan capture — detect writes to watched directories (async, non-blocking)
      const planFilePath = isPlanWriteEvent(
        toolName,
        event.tool_input as Record<string, unknown> | undefined,
        planWatchConfig,
      );
      if (planFilePath) {
        const captureSessionId = event.session_id;
        fs.promises.readFile(planFilePath, 'utf-8').then((planContent) => {
          const latestBatch = getLatestBatch(captureSessionId);
          capturePlan({
            sourcePath: planFilePath,
            projectRoot,
            content: planContent,
            sessionId: captureSessionId,
            promptBatchId: latestBatch?.id ?? null,
            logger,
          });
          logger.info(LOG_KINDS.CAPTURE_PLAN, 'Plan captured', {
            session_id: captureSessionId,
            source_path: planFilePath,
          });
        }).catch((err) => {
          logger.warn(LOG_KINDS.CAPTURE_PLAN, 'Failed to capture plan', {
            error: (err as Error).message,
            path: planFilePath,
          });
        });
      }
      try {
        handleToolUse(
          event.session_id,
          toolName,
          event.tool_input,
          typeof event.output_preview === 'string' ? event.output_preview : undefined,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record activity', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'tool_failure') {
      const toolName = String(event.tool_name ?? '');
      logger.info(LOG_KINDS.HOOKS_TOOL, 'Tool failure event', {
        session_id: event.session_id,
        tool_name: toolName,
        is_interrupt: !!event.is_interrupt,
      });
      try {
        handleToolFailure(
          event.session_id,
          toolName,
          event.tool_input,
          typeof event.error === 'string' ? event.error : undefined,
          !!event.is_interrupt,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record tool failure', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'subagent_start') {
      logger.info(LOG_KINDS.HOOKS_SUBAGENT, 'Subagent start event', {
        session_id: event.session_id,
        agent_id: event.agent_id,
        agent_type: event.agent_type,
      });
      try {
        handleSubagentStart(
          event.session_id,
          typeof event.agent_id === 'string' ? event.agent_id : undefined,
          typeof event.agent_type === 'string' ? event.agent_type : undefined,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record subagent start', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'subagent_stop') {
      logger.info(LOG_KINDS.HOOKS_SUBAGENT, 'Subagent stop event', {
        session_id: event.session_id,
        agent_id: event.agent_id,
        agent_type: event.agent_type,
      });
      try {
        handleSubagentStop(
          event.session_id,
          typeof event.agent_id === 'string' ? event.agent_id : undefined,
          typeof event.agent_type === 'string' ? event.agent_type : undefined,
          typeof event.last_assistant_message === 'string' ? event.last_assistant_message : undefined,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record subagent stop', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'stop_failure') {
      logger.warn(LOG_KINDS.HOOKS_STOP, 'Stop failure event', {
        session_id: event.session_id,
        error: event.error,
      });
      try {
        handleStopFailure(
          event.session_id,
          typeof event.error === 'string' ? event.error : undefined,
          typeof event.error_details === 'string' ? event.error_details : undefined,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record stop failure', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'task_completed') {
      logger.info(LOG_KINDS.HOOKS_EVENT, 'Task completed event', {
        session_id: event.session_id,
        task_id: event.task_id,
        task_subject: event.task_subject,
      });
      try {
        handleTaskCompleted(
          event.session_id,
          typeof event.task_id === 'string' ? event.task_id : undefined,
          typeof event.task_subject === 'string' ? event.task_subject : undefined,
          typeof event.task_description === 'string' ? event.task_description : undefined,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record task completion', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'pre_compact') {
      logger.info(LOG_KINDS.HOOKS_EVENT, 'Pre-compact event', { session_id: event.session_id });
      try {
        handleCompact(
          event.session_id,
          'pre',
          typeof event.trigger === 'string' ? event.trigger : undefined,
          undefined,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record pre-compact', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'post_compact') {
      logger.info(LOG_KINDS.HOOKS_EVENT, 'Post-compact event', { session_id: event.session_id });
      try {
        handleCompact(
          event.session_id,
          'post',
          typeof event.trigger === 'string' ? event.trigger : undefined,
          typeof event.compact_summary === 'string' ? event.compact_summary : undefined,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record post-compact', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    return { body: { ok: true } };
  };
}
