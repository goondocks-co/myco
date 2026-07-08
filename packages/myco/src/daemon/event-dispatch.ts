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
import { resolveProjectBufferDir } from '@myco/grove/paths.js';
import { PowerManager } from './power.js';
import { DaemonLogger } from './logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { resolveTenantConfig } from './request-config.js';
import type { PlanWatchConfig } from './plan-capture.js';
import {
  isPlanWriteEvent,
  capturePlan,
  captureTaggedPlan,
  extractTaggedPlans,
} from './plan-capture.js';
import {
  handleUserPrompt,
  handleToolUse,
  handleToolFailure,
  handleSubagentStart,
  handleSubagentStop,
  handleStopFailure,
  handleTaskCompleted,
  handleCompact,
} from './event-handlers.js';
import { handleCanopyToolUse } from '@myco/canopy/scanner/handle-tool-use.js';
import {
  filesystemRootFromRequestContext,
  isHostServedRequest,
  projectScopeFromRequestContext,
  rowProjectIdFromRequestContext,
  type MycoRequestContext,
} from '@myco/grove/request-context.js';
import { hostSubstitutedTranscriptPath } from '@myco/host/routed-transcript.js';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import { getDatabase } from '@myco/db/client.js';
import { getLatestBatch, toPromptBatchOrigin, type PromptBatchOrigin } from '@myco/db/queries/batches.js';
import { getSession, updateSession, reactivateSessionIfCompleted } from '@myco/db/queries/sessions.js';
import { hasSessionTombstone } from '@myco/db/queries/session-tombstones.js';
import { ensureSession, ensureSessionRowExists, ENSURE_SESSION_SOURCE } from './session-lifecycle.js';
import { captureBatchImages, type CapturedImage } from './capture-images.js';
import { DEFAULT_SYMBIONT_NAME, epochSeconds, LOG_PROMPT_PREVIEW_CHARS } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { loadManifests } from '@myco/symbionts/detect.js';
import { gateEventByCaptureRules } from './capture-gating.js';
import { normalizeAcceptedUserPromptEvent } from '@myco/capture/user-prompt-event.js';
import { EventDedupCache } from './event-dedup-cache.js';
import { assertGroveProjectId, isGroveEraId } from '@myco/grove/ids.js';
import type { ProjectPowerStateTracker } from './project-power-state.js';
import { deferGitProvenance } from '@myco/release-provenance/capture.js';
import { primaryProductionRef } from '@myco/release-provenance/config.js';

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
  /**
   * Throttled live transcript reconcile, invoked on tool events. Surfaces
   * queued steering prompts and in-flight responses mid-turn (the daemon
   * receives tool events live and has the transcript path) instead of waiting
   * for Stop. Optional: when absent, capture stays Stop-only. The callee owns
   * throttling — the dispatcher calls it on every tool event.
   */
  liveReconcile?: (sessionId: string, agent: string, transcriptPath: string) => void;
  planWatchConfig: PlanWatchConfig; // object reference — mutated in place for hot-reload
  triggerTitleSummary: (
    sessionId: string,
    requestContext: MycoRequestContext | undefined,
    trigger?: { evaluateBoundary: true; promptOrigin: PromptBatchOrigin },
  ) => Promise<void>;
  /**
   * Per-project power state. user_prompt events on a session count as
   * activity for that session's project, keeping its scheduler ticking
   * even when it isn't the foreground project in the web UI.
   */
  projectStateTracker?: ProjectPowerStateTracker;
  /**
   * Shared duplicate cache — the buffer reconciler records replayed events
   * into the same instance so a late live POST of an already-replayed event
   * is rejected here. When absent (tests), a private instance is used.
   */
  eventDedupCache?: EventDedupCache;
  /**
   * Clear the session's converged mark (the reconciler's identity map) when
   * a per-type handler fails after the daemon-side buffer append succeeded.
   * The appended copy is then unconverged by construction, and the next
   * quiescent boundary (post-Stop trigger / drain pass / boot) replays it —
   * the recovery mechanism the honest `persisted:false, buffered:true`
   * response promises hooks, so they don't double-buffer.
   */
  clearConvergedMark?: (sessionId: string) => void;
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
    liveReconcile,
    planWatchConfig,
    triggerTitleSummary,
  } = deps;

  const projectRoot = resolveProjectRoot(vaultDir);
  const manifests = loadManifests();
  const planTagsByAgent = new Map(
    manifests.map((manifest) => [manifest.name, manifest.capture?.planTags ?? []] as const),
  );

  // Dedup cache for event idempotency. Suppresses identical /events POSTs
  // within the dedup window — hook scripts re-fire the same event when the
  // daemon was previously slow or briefly unavailable (Claude Code retries,
  // multi-symbiont overlap, Codex's user_prompt-submit hook observed firing
  // twice within ~30ms), and the inserts at handleUserPrompt /
  // insertActivityWithBatch have no natural idempotency. The 10-second
  // window catches retry storms without suppressing legitimate same-text
  // turns. Key includes session_id, type, and a content fingerprint (see
  // `@myco/capture/dedup.js`) so the cache can distinguish "same prompt sent
  // twice" from "same hook type for two different prompts." Shared with the
  // buffer reconciler so duplicates the live path correctly rejected don't
  // resurrect on replay — and so replayed events reject late live copies.
  const eventDedupCache = deps.eventDedupCache ?? new EventDedupCache();

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

  // Per-session set of `agent_id`s seen on a Subagent start event. Used to
  // distinguish real subagent completions (always paired Start+Stop, non-empty
  // agent_type) from Claude Code's synthetic per-turn SubagentStop fires
  // (empty agent_type, no preceding Start). The latter arrive ~3-5s after
  // the turn's Stop and used to fabricate a phantom `kind='recovered'`
  // batch via `ensureOpenBatch`. We now drop them at dispatch.
  const startedSubagents = new Map<string, Set<string>>();
  const STARTED_SUBAGENT_SESSION_CAP = 1024;
  function recordSubagentStart(sessionId: string, agentId: string | undefined): void {
    if (!agentId) return;
    let set = startedSubagents.get(sessionId);
    if (!set) {
      if (startedSubagents.size >= STARTED_SUBAGENT_SESSION_CAP) {
        const oldest = startedSubagents.keys().next().value;
        if (oldest !== undefined) startedSubagents.delete(oldest);
      }
      set = new Set();
      startedSubagents.set(sessionId, set);
    }
    set.add(agentId);
  }
  function isSyntheticSubagentStop(sessionId: string, agentId: string | undefined, agentType: string | undefined): boolean {
    if (agentType && agentType.length > 0) return false;
    if (!agentId) return true;
    return !startedSubagents.get(sessionId)?.has(agentId);
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
    let event = {
      ...validated,
      timestamp: (validated as Record<string, unknown>).timestamp ?? new Date().toISOString(),
    } as Record<string, unknown> & { type: string; session_id: string; timestamp: string };

    try {
      const normalized = normalizeAcceptedUserPromptEvent(event, { manifests });
      event = normalized.event;
      if (normalized.action === 'rewrite') {
        logger.info(LOG_KINDS.HOOKS_PROMPT, 'User prompt rewritten by capture rule', {
          session_id: event.session_id,
          agent: normalized.agent,
          reason: normalized.reason ?? 'rule',
        });
      }
    } catch (err) {
      logger.error(LOG_KINDS.HOOKS_PROMPT, 'User-prompt capture-rules evaluator threw', {
        error: String(err),
        session_id: event.session_id,
        agent: typeof event.agent === 'string' ? event.agent : DEFAULT_SYMBIONT_NAME,
      });
    }

    let userPromptBatchId: number | undefined;
    // Honest response contract: `persisted` reports whether every per-type
    // handler that ran for this event committed its writes; `buffered`
    // reports whether the daemon-side buffer append (which runs BEFORE the
    // handlers) holds a durable copy the reconciler can replay. Types with
    // no persisting handler (notification, error_occurred, …) report
    // `persisted: true` — there is nothing to persist, so success is
    // vacuous and the field still marks this daemon as contract-aware.
    let handlerFailed = false;
    let daemonBuffered = false;
    const requestProjectId = rowProjectIdFromRequestContext(req.requestContext);
    const requestProjectRoot = req.requestContext?.projectRoot ?? projectRoot;
    const requestFilesystemRoot = req.requestContext
      ? filesystemRootFromRequestContext(req.requestContext)
      : requestProjectRoot;
    const requestMachineId = req.requestContext?.machineId ?? machineId;

    // Team Host — C4: for a session host-served for a remote member, the event's
    // `transcript_path` is a MEMBER-local path that does not exist on this host.
    // Substitute it with the file C2 materialized at
    // `routed-transcripts/<machine>/<session>/<tid>.jsonl`, resolved from
    // (machineId, sessionId), BEFORE any ensureSession*/live-mining site below —
    // so live mid-turn mining reads a file that exists here. A local request is
    // untouched; a routed session whose bytes haven't drained yet degrades to no
    // path (no bogus mine — replay/re-enrich recovers). §5.3 / C4.
    {
      const memberTranscriptPath = typeof event.transcript_path === 'string' && event.transcript_path.length > 0
        ? event.transcript_path
        : undefined;
      const substitution = hostSubstitutedTranscriptPath({
        hostServed: isHostServedRequest(req.requestContext),
        machineId: requestMachineId,
        sessionId: event.session_id,
        memberTranscriptPath,
      });
      if (substitution.action !== 'unchanged') {
        event.transcript_path = substitution.transcriptPath;
        logger.debug(LOG_KINDS.PROCESSOR_TRANSCRIPT, 'Routed transcript_path substituted for host-served event', {
          session_id: event.session_id,
          action: substitution.action,
        });
      }
    }

    logger.debug(LOG_KINDS.HOOKS_EVENT, 'Event received', { type: event.type, session_id: event.session_id });

    // Suppress hook-side retry storms before they create duplicate batches /
    // activities. A wedged-then-recovered daemon, or two symbionts watching
    // the same project, can deliver the same physical event multiple times
    // within seconds; the downstream insert paths are not idempotent.
    if (eventDedupCache.isDuplicate(event, Date.now())) {
      // Promoted from debug to info so `grep hooks.event` in the default
      // daemon log surfaces the volume of in-flight duplicate-fire patterns
      // (Codex's double-fire, Claude retries, multi-symbiont overlap) — a
      // class of bug we keep re-discovering only by manual buffer inspection.
      logger.info(LOG_KINDS.HOOKS_EVENT, 'Event suppressed as duplicate within dedup window', {
        type: event.type, session_id: event.session_id,
      });
      return { body: { ok: true, ignored: 'duplicate', persisted: false } };
    }

    // Ensure session is registered (idempotent — handles daemon restarts mid-session)
    if (!registry.getSession(event.session_id)) {
      // Rehydrate from SQLite before running capture rules. A session row
      // means we already admitted this session (on a prior run or earlier in
      // this run); re-gating it risks applying phantom-detection rules to a
      // legitimate mid-flight session whose in-memory registry was lost on
      // daemon restart. The capture gate is for first-sight sessions only.
      const existingRow = getSession(event.session_id, projectScopeFromRequestContext(req.requestContext));
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
          return { body: { ok: true, ignored: reason, persisted: false } };
        }
        if (shouldReevaluate) {
          droppedSessions.delete(event.session_id);
        }
        if (hasSessionTombstone(event.session_id)) {
          // Deletion is final against passive event-driven recreation (an
          // explicit /sessions/register deliberately supersedes — same-id
          // reload is a supported flow). hadTranscriptMeta: true makes the
          // cached drop permanent: a later transcript_path must not reopen
          // resurrection for a deliberately deleted session.
          rememberDropped(event.session_id, 'session_tombstoned', true);
          logger.info(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'Ignored event for deleted (tombstoned) session', {
            session_id: event.session_id,
            type: event.type,
          });
          return { body: { ok: true, ignored: 'session_tombstoned', persisted: false } };
        }
        const { decision, hadTranscriptMeta } = evaluateAutoRegistration(event);
        if (decision.action === 'drop') {
          rememberDropped(event.session_id, decision.reason, hadTranscriptMeta);
          logger.info(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'Ignored event that failed session capture rules', {
            session_id: event.session_id,
            type: event.type,
            reason: decision.reason ?? 'rule',
          });
          return { body: { ok: true, ignored: decision.reason ?? 'rule', persisted: false } };
        }

        // Persist + register through the single lifecycle helper. ordering
        // matters: DB row first, then in-memory registry. See
        // `session-lifecycle.ts` for the invariant rationale.
        ensureSession({
          sessionId: event.session_id,
          agent: ((event as Record<string, unknown>).agent as string) ?? DEFAULT_SYMBIONT_NAME,
          projectId: requestProjectId,
          projectRoot: requestProjectRoot,
          machineId: requestMachineId,
          startedAt: event.timestamp,
          registry,
          logger,
          source: event.type === 'user_prompt' ? ENSURE_SESSION_SOURCE.USER_PROMPT : ENSURE_SESSION_SOURCE.TOOL_USE,
        });
        logger.info(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'Auto-registered session from event', { session_id: event.session_id });
        const autoRegisterScope = projectScopeFromRequestContext(req.requestContext);
        deferGitProvenance(
          {
            projectRoot: requestProjectRoot,
            projectId: requestProjectId,
            machineId: requestMachineId,
            sessionId: event.session_id,
            capturePoint: 'session_start',
            productionRef: primaryProductionRef(resolveTenantConfig(req.requestContext, liveConfig.current, { logger })),
            logger,
          },
          (provenance) => {
            if (provenance?.branch) {
              updateSession(event.session_id, { branch: provenance.branch }, autoRegisterScope);
            }
          },
        );

        // Reconcile buffer against DB — recover any prompts lost during downtime.
        reconcileSession(event.session_id);
      }
    }

    // Persist to disk so events survive daemon restarts. The buffer lives
    // under the owning project's Grove dir, resolved from the bound
    // request context. There is NO fallback location — request context
    // missing either id means we can't safely route the buffer to its
    // owning project, and silently writing to a substitute path is the
    // bug class we kept rediscovering through Grove migration regressions.
    // Skip the buffer write and log it; the event still flows through the
    // live DB path above.
    if (!sessionBuffers.has(event.session_id)) {
      const ctx = req.requestContext;
      if (!ctx?.groveId || !ctx?.projectId) {
        logger.warn(LOG_KINDS.CAPTURE_BUFFER, 'Skipping buffer write — request context missing grove/project ids', {
          session_id: event.session_id,
          has_grove: !!ctx?.groveId,
          has_project: !!ctx?.projectId,
        });
      } else {
        const bufferDir = resolveProjectBufferDir(ctx.groveId, ctx.projectId);
        sessionBuffers.set(event.session_id, new EventBuffer(bufferDir, event.session_id));
      }
    }
    try {
      const buffer = sessionBuffers.get(event.session_id);
      if (buffer) {
        buffer.append(event);
        daemonBuffered = true;
      }
    } catch (err) {
      // The append failing must not block the live DB path — but the
      // response below reports `buffered: false` so the hook knows no
      // daemon-side copy exists and can take the buffer fallback itself.
      logger.warn(LOG_KINDS.CAPTURE_BUFFER, 'Daemon-side buffer append failed', {
        session_id: event.session_id,
        type: event.type,
        error: String(err),
      });
    }

    // --- Prompt batch tracking ---
    if (event.type === 'user_prompt') {
      powerManager.recordActivity();
      const requestProjectId = req.requestContext?.projectId;
      if (
        deps.projectStateTracker &&
        requestProjectId &&
        isGroveEraId(requestProjectId, 'project') &&
        req.requestContext?.groveId
      ) {
        deps.projectStateTracker.recordActivity(
          req.requestContext.groveId,
          assertGroveProjectId(requestProjectId),
        );
      }
      const promptText = String(event.prompt ?? '');
      // Origin is forwarded by the hook from manifest set_origin rules;
      // toPromptBatchOrigin coerces unknowns to 'human'.
      const promptOrigin = toPromptBatchOrigin(event.origin);
      // Non-human batches (system reminders, teammate messages, task
      // notifications, …) are high-volume background traffic — log at
      // debug so they don't drown out real user activity in default logs.
      const promptLogPayload = {
        session_id: event.session_id,
        prompt_preview: promptText.slice(0, LOG_PROMPT_PREVIEW_CHARS),
        prompt_length: promptText.length,
        origin: promptOrigin,
      };
      if (promptOrigin === 'human') {
        logger.info(LOG_KINDS.HOOKS_PROMPT, 'User prompt received', promptLogPayload);
      } else {
        logger.debug(LOG_KINDS.HOOKS_PROMPT, 'User prompt received', promptLogPayload);
      }
      // Flip a completed session back to active on genuine user activity.
      // The auto-register branch above only reactivates when the session
      // isn't in the in-memory registry (e.g., after daemon restart) —
      // without this, a manually-completed or stale-swept session stays
      // hidden from intelligence-task queries even after the user resumes.
      if (reactivateSessionIfCompleted(event.session_id, projectScopeFromRequestContext(req.requestContext))) {
        logger.info(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'Reactivated completed session on new activity', {
          session_id: event.session_id,
        });
      }
      try {
        // Defensive layer: the registry-gated auto-register above is an
        // optimization, not the contract. The contract is that a
        // sessions.id row must exist by the time we open a prompt_batch.
        // If anything upstream missed (e.g. an event arrived before
        // session-start, or a future refactor breaks the gate), this
        // recovers via an INSERT-IF-MISSING + WARN log so the bug
        // surfaces instead of cascading into FK violations downstream.
        ensureSessionRowExists({
          sessionId: event.session_id,
          agent: ((event as Record<string, unknown>).agent as string) ?? undefined,
          projectId: requestProjectId,
          projectRoot: requestProjectRoot,
          machineId: requestMachineId,
          logger,
          source: ENSURE_SESSION_SOURCE.USER_PROMPT,
        });
        const kind = typeof event.kind === 'string' ? event.kind : 'initial';
        const { batchId, promptNumber } = handleUserPrompt(event.session_id, promptText || undefined, { kind, origin: promptOrigin });
        userPromptBatchId = batchId;
        logger.debug(LOG_KINDS.CAPTURE_BATCH, 'Batch opened', { session_id: event.session_id, batch_id: batchId, prompt_number: promptNumber });
        deferGitProvenance({
          projectRoot: requestProjectRoot,
          projectId: requestProjectId,
          machineId: requestMachineId,
          sessionId: event.session_id,
          promptBatchId: batchId,
          capturePoint: 'prompt_batch_start',
          productionRef: primaryProductionRef(resolveTenantConfig(req.requestContext, liveConfig.current, { logger })),
          promptOrigin,
          logger,
        });

        const taggedPlans = extractTaggedPlans(promptText, getPlanTagsForAgent(event.agent), promptOrigin);
        for (const { tag, content } of taggedPlans) {
          try {
            captureTaggedPlan({
              tag,
              content,
              sessionId: event.session_id,
              projectId: requestProjectId,
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
        // Tenancy is the caller's request context — never the daemon's
        // bootstrap-anchor vault. Without a resolved project id we have no
        // tenant to attribute the attachment rows to; skip rather than
        // synthesizing tenancy from the anchor (the cross-tenant leak class).
        const imageProjectId = req.requestContext?.projectId;
        if (Array.isArray(eventImages) && eventImages.length > 0 && imageProjectId) {
          captureBatchImages({
            sessionId: event.session_id,
            promptBatchId: batchId,
            promptNumber,
            images: eventImages,
            logger,
            projectId: imageProjectId,
          });
        }

        // Boundary policy (origin filter + N-th human-batch crossing) lives
        // inside the trigger; the dispatcher just hands it the event's origin.
        triggerTitleSummary(event.session_id, req.requestContext, { evaluateBoundary: true, promptOrigin });

        // A new human prompt is a turn boundary: the PRIOR turn definitively
        // ended, and its response is now complete in the transcript. Converge
        // it here so a turn whose tail was text-only (a final summary with no
        // trailing tool call — e.g. after a steering prompt) is attributed
        // without waiting for a tool event that never comes. Tool events remain
        // a mid-turn liveness optimization, not the correctness mechanism. Same
        // throttled unit of work the tool path uses; deferred off the hot path.
        if (liveReconcile && typeof event.transcript_path === 'string' && event.transcript_path) {
          const reconcileAgent = typeof event.agent === 'string' ? event.agent : DEFAULT_SYMBIONT_NAME;
          const reconcileTranscript = event.transcript_path;
          setTimeout(() => liveReconcile(event.session_id, reconcileAgent, reconcileTranscript), 0);
        }
      } catch (err) {
        handlerFailed = true;
        logger.warn(LOG_KINDS.CAPTURE_BATCH, 'Failed to open batch', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'tool_use') {
      const toolName = String(event.tool_name ?? '');
      logger.debug(LOG_KINDS.HOOKS_TOOL, 'Tool use event', {
        session_id: event.session_id,
        tool_name: toolName,
      });
      // Plan capture — detect writes to watched directories (async, non-blocking).
      // Resolve the watch dirs against the REQUEST's project root, not
      // `planWatchConfig.projectRoot` — on the global daemon that root is the
      // bootstrap/phantom home (MYCO_HOME), so matching a plan write in the
      // requesting project's tree against it always fails and the write is
      // never captured in real time (only the Stop-scan backstop, which already
      // uses the request root, catches it). Same per-request tenancy rule as
      // the rest of the daemon.
      const planFilePath = isPlanWriteEvent(
        toolName,
        event.tool_input as Record<string, unknown> | undefined,
        { ...planWatchConfig, projectRoot: requestProjectRoot },
      );
      if (planFilePath) {
        const captureSessionId = event.session_id;
        fs.promises.readFile(planFilePath, 'utf-8').then((planContent) => {
          const latestBatch = getLatestBatch(captureSessionId);
            capturePlan({
              sourcePath: planFilePath,
              projectRoot: requestProjectRoot,
              projectId: requestProjectId,
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
        // Defensive: same belt-and-suspenders pattern as the user_prompt
        // branch above. activities.session_id is FK-constrained, so the
        // sessions.id row must exist by here.
        ensureSessionRowExists({
          sessionId: event.session_id,
          agent: typeof event.agent === 'string' ? event.agent : undefined,
          projectId: requestProjectId,
          projectRoot: requestProjectRoot,
          machineId: requestMachineId,
          logger,
          source: ENSURE_SESSION_SOURCE.TOOL_USE,
        });
        handleToolUse(
          event.session_id,
          typeof event.agent === 'string' ? event.agent : DEFAULT_SYMBIONT_NAME,
          toolName,
          event.tool_input,
          typeof event.output_preview === 'string' ? event.output_preview : undefined,
          requestFilesystemRoot,
          typeof event.transcript_path === 'string' ? event.transcript_path : undefined,
        );
      } catch (err) {
        handlerFailed = true;
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record activity', { session_id: event.session_id, error: (err as Error).message });
      }
      // Live capture: surface queued prompts + in-flight responses mid-turn.
      // The agent writes each turn's prompts/responses to the transcript as it
      // works; this tool event is the daemon's live signal to re-mine it. The
      // callee throttles (≤1 run/interval/session), but a single run still does
      // a full transcript re-parse + DB writes — too heavy to run inline on the
      // /events handler thread. Defer it off the hot path with setTimeout(0),
      // exactly like the Canopy rescan below, so the hook's HTTP response isn't
      // blocked by capture work (avoids the main-loop-wedge class fixed in
      // project_main_loop_yield_pattern).
      if (liveReconcile && typeof event.transcript_path === 'string' && event.transcript_path) {
        const agent = typeof event.agent === 'string' ? event.agent : DEFAULT_SYMBIONT_NAME;
        const transcriptPath = event.transcript_path;
        setTimeout(() => liveReconcile(event.session_id, agent, transcriptPath), 0);
      }
      // Canopy: rescan the touched file after acknowledging capture.
      // Best-effort; handleCanopyToolUse swallows its own errors.
      // Tenancy is the caller's request context — never the daemon's
      // bootstrap-anchor vault. Without a resolved project id we skip the
      // rescan rather than synthesizing tenancy from the anchor (the
      // cross-tenant leak class); capture has already succeeded regardless.
      const canopyProjectId = req.requestContext?.projectId;
      if (canopyProjectId) {
        setTimeout(() => {
          try {
            handleCanopyToolUse({
              db: getDatabase(),
              logger,
              machineId: requestMachineId,
              projectRoot: requestFilesystemRoot,
              projectId: canopyProjectId,
              toolName,
              toolInput: event.tool_input,
              defaultExcludePatterns: liveConfig.current.cortex.canopy.exclude.default_patterns,
              excludePatterns: liveConfig.current.cortex.canopy.exclude.patterns,
            });
          } catch {
            // The deferred scanner is observability-only; capture already succeeded.
          }
        }, 0);
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
          typeof event.agent === 'string' ? event.agent : DEFAULT_SYMBIONT_NAME,
          toolName,
          event.tool_input,
          typeof event.error === 'string' ? event.error : undefined,
          !!event.is_interrupt,
        );
      } catch (err) {
        handlerFailed = true;
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record tool failure', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'subagent_start') {
      const agentId = typeof event.agent_id === 'string' ? event.agent_id : undefined;
      const agentType = typeof event.agent_type === 'string' ? event.agent_type : undefined;
      logger.info(LOG_KINDS.HOOKS_SUBAGENT, 'Subagent start event', {
        session_id: event.session_id,
        agent_id: agentId,
        agent_type: agentType,
      });
      recordSubagentStart(event.session_id, agentId);
      try {
        handleSubagentStart(event.session_id, agentId, agentType);
      } catch (err) {
        handlerFailed = true;
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record subagent start', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'subagent_stop') {
      const agentId = typeof event.agent_id === 'string' ? event.agent_id : undefined;
      const agentType = typeof event.agent_type === 'string' ? event.agent_type : undefined;
      // Claude Code fires a SubagentStop hook for the main agent itself
      // after every turn's Stop (empty agent_type, no preceding Start).
      // It carries no semantic information; record nothing.
      if (isSyntheticSubagentStop(event.session_id, agentId, agentType)) {
        logger.info(LOG_KINDS.HOOKS_SUBAGENT, 'Dropped synthetic subagent_stop', {
          session_id: event.session_id,
          agent_id: agentId,
        });
        return { body: { ok: true, ignored: 'synthetic-subagent-stop', persisted: false } };
      }
      logger.info(LOG_KINDS.HOOKS_SUBAGENT, 'Subagent stop event', {
        session_id: event.session_id,
        agent_id: agentId,
        agent_type: agentType,
      });
      try {
        handleSubagentStop(
          event.session_id,
          agentId,
          agentType,
          typeof event.last_assistant_message === 'string' ? event.last_assistant_message : undefined,
        );
      } catch (err) {
        handlerFailed = true;
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
        handlerFailed = true;
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
        handlerFailed = true;
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
        handlerFailed = true;
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
        handlerFailed = true;
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record post-compact', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    // Honest outcome assembly. A failed handler answers `persisted: false`
    // plus whether the daemon-side append holds a durable copy:
    //
    //   buffered: true  — recovery is daemon-owned. Clear the converged
    //                     mark so the appended copy replays at the next
    //                     quiescent boundary; the hook must NOT re-buffer
    //                     (the double-buffer trap).
    //   buffered: false — no daemon-side copy exists (the missing-grove/
    //                     project-context path, or the append itself
    //                     failed). The hook's buffer fallback is the only
    //                     durable copy; it should buffer.
    if (handlerFailed) {
      deps.clearConvergedMark?.(event.session_id);
      return { body: { ok: true, persisted: false, buffered: daemonBuffered } };
    }
    return { body: { ok: true, persisted: true, ...(userPromptBatchId != null ? { batchId: userPromptBatchId } : {}) } };
  };
}
