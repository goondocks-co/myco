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
import { isPlanWriteEvent, capturePlan } from './plan-capture.js';
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
import { upsertSession } from '@myco/db/queries/sessions.js';
import { epochSeconds, LOG_PROMPT_PREVIEW_CHARS } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

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
  config: MycoConfig;
  vaultDir: string;
  reconcileSession: (sessionId: string) => void;
  planWatchConfig: PlanWatchConfig; // object reference — mutated in place for hot-reload
  triggerTitleSummary: (sessionId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEventDispatcher(deps: EventDispatchDeps): RouteHandler {
  const {
    registry,
    sessionBuffers,
    powerManager,
    logger,
    machineId,
    config,
    vaultDir: vaultDir,
    reconcileSession,
    planWatchConfig,
    triggerTitleSummary,
  } = deps;

  const projectRoot = process.cwd();

  return async (req) => {
    const validated = EventBody.parse(req.body);
    const event = {
      ...validated,
      timestamp: (validated as Record<string, unknown>).timestamp ?? new Date().toISOString(),
    } as Record<string, unknown> & { type: string; session_id: string; timestamp: string };

    logger.debug(LOG_KINDS.HOOKS_EVENT, 'Event received', { type: event.type, session_id: event.session_id });

    // Ensure session is registered (idempotent — handles daemon restarts mid-session)
    if (!registry.getSession(event.session_id)) {
      registry.register(event.session_id, { started_at: event.timestamp });
      logger.debug(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'Auto-registered session from event', { session_id: event.session_id });

      // Ensure SQLite session exists — explicitly set status='active' so
      // resumed sessions (previously 'completed') get reopened.
      const now = epochSeconds();
      const startedEpoch = Math.floor(new Date(event.timestamp).getTime() / 1000);
      upsertSession({
        id: event.session_id,
        agent: (event as Record<string, unknown>).agent as string ?? 'claude-code',
        status: 'active',
        started_at: startedEpoch,
        created_at: now,
        machine_id: machineId,
      });

      // Reconcile buffer against DB — recover any prompts lost during downtime.
      reconcileSession(event.session_id);
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
        try {
          const { batchId, promptNumber } = handleUserPrompt(event.session_id, promptText || undefined);
          logger.debug(LOG_KINDS.CAPTURE_BATCH, 'Batch opened', { session_id: event.session_id, batch_id: batchId, prompt_number: promptNumber });

          // Batch-threshold summary trigger
          const batchCount = promptNumber;
          const summaryInterval = config.agent.summary_batch_interval;
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
            sourcePath: path.relative(projectRoot, planFilePath),
            content: planContent,
            sessionId: captureSessionId,
            promptBatchId: latestBatch?.id ?? null,
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
