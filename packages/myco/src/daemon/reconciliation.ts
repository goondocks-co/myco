/**
 * Buffer reconciliation factory for the Myco daemon.
 *
 * The buffer is the authoritative event log — JSONL files on disk. The DB
 * (prompt_batches + activities) is a derived view. After a daemon restart,
 * reconciliation replays missed events from buffer files to keep the DB in sync.
 */

import fs from 'node:fs';
import path from 'node:path';
import { listBufferSessionIds, cleanStaleBuffers, type BufferCleanupDecision } from '@myco/capture/buffer.js';
import { bufferDirCurrentRegistration, bufferDirIdentity } from '@myco/capture/buffer-location.js';
import { openDatabase, withDatabase, type Database } from '@myco/db/client.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import {
  listBatchesBySession,
  getLatestBatch,
  setResponseSummary,
  toPromptBatchOrigin,
  PROMPT_PREFIX_MATCH_CHARS,
  type BatchRow,
} from '@myco/db/queries/batches.js';
import { listActivities, latestActivityTimestampForBatch } from '@myco/db/queries/activities.js';
import { getSession, closeSession } from '@myco/db/queries/sessions.js';
import { hasSessionTombstone } from '@myco/db/queries/session-tombstones.js';
import { getTeamMachineId } from '@myco/team/context.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import {
  STALE_BUFFER_MAX_AGE_MS,
  STALE_SESSION_THRESHOLD_MS,
  STOP_REPLAY_OPEN_BATCH_FRESHNESS_MS,
  DEFAULT_SYMBIONT_NAME,
  MS_PER_SECOND,
  epochSeconds,
} from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { DaemonLogger } from './logger.js';
import type { EventDedupCache } from './event-dedup-cache.js';
import type { SessionRegistry } from './lifecycle.js';
import { handleUserPrompt, handleToolUse, handleToolFailure } from './event-handlers.js';
import { ensureSession, ENSURE_SESSION_SOURCE } from './session-lifecycle.js';
import { gateEventByCaptureRules } from './capture-gating.js';
import { classifyNextPromptDecision } from '@myco/capture/prompt-kind.js';
import {
  eventDedupKey,
  eventTimestampMs,
  EVENT_DEDUP_WINDOW_MS,
  convergenceEventKey,
  dedupKeyFromPromptBatch,
  dedupKeyFromActivity,
  isBookkeepingActivity,
} from '@myco/capture/dedup.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Event types replayed during buffer reconciliation. */
const REPLAYABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'user_prompt',
  'tool_use',
  'tool_failure',
  // `stop` events carry the last assistant message and need to survive daemon
  // downtime so response_summary isn't lost when the TUI fires idle during a
  // restart window. Replay sets the summary on the session's latest batch
  // without re-running full stop processing (which already ran live).
  'stop',
]);

/**
 * Row-fetch bound for the convergence multiset. A session's buffer file holds
 * at most a few hundred events; this just keeps the query bounded against a
 * pathological session without ever truncating a realistic one (the default
 * list limits — 200 batches / 100 activities — WOULD truncate and silently
 * re-insert the tail as duplicates).
 */
const CONVERGENCE_QUERY_LIMIT = 100_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconcilerDeps {
  /**
   * Every buffer directory the reconciler should scan. One per registered
   * project under the global install at
   * `~/.myco/groves/<groveId>/projects/<projectId>/buffer/`. There is NO
   * legacy fallback — `capture/buffer-location.ts` enforces the
   * no-divergent-location invariant structurally, and the reconciler
   * trusts that contract. Derived from `listAllProjectBufferDirs()`.
   *
   * Order matters only for log determinism; per-session lookup tries each
   * directory in order and uses the first match (a session's events live
   * in exactly one dir).
   */
  bufferDirs: string[];
  logger: DaemonLogger;
  /** Canonical project root — derived from vaultDir, never cwd. */
  projectRoot: string;
  /**
   * Fires once after `reconcileSession` finishes for a session. Wrapped in
   * try/catch by the reconciler — thrown errors are logged and swallowed.
   */
  onSessionReconciled?: (sessionId: string) => void;
  /**
   * Shared live duplicate cache (same instance the /events dispatcher
   * consults). Every replayed event's key is recorded into it at replay
   * time so a late live POST of the same physical event is rejected as a
   * duplicate instead of double-inserting.
   */
  eventDedupCache?: EventDedupCache;
  /**
   * In-memory session registry, used when resurrection re-creates a
   * session row (ensureSession registers the id after persisting).
   * Optional: when absent, the DB row is still the source of truth and
   * the registry — a cache by contract — is simply not warmed.
   */
  registry?: Pick<SessionRegistry, 'register'>;
  /**
   * Machine id stamped onto resurrected session rows. Falls back to
   * `getTeamMachineId()` — the identical default `upsertSession` applies
   * when no machine id is supplied.
   */
  machineId?: string;
  /**
   * Resolve an open handle to a served Grove's SQLite DB, or `null` when
   * that Grove's DB does not exist yet. Every per-dir unit of work
   * (reconcile, cleanup classification) runs inside
   * `withDatabase(resolveGroveDb(groveId), …)` so `getDatabase()` reads
   * the Grove DB that OWNS the buffer dir — never the process singleton,
   * which on the daemon is the bootstrap/anchor vault. The daemon passes
   * a `GroveRuntimeCache`-backed resolver (shared connections, schema
   * ensured); the default opens the Grove DB file directly when it
   * exists. A buffer dir that is not Grove-shaped (legacy/test layouts)
   * runs unscoped against the ambient DB.
   */
  resolveGroveDb?: (groveId: string) => Database | null;
}

export interface Reconciler {
  reconcileSession(sessionId: string): void;
  replayEvent(sessionId: string, event: Record<string, unknown>): 'prompt' | 'activity' | null;
  runStartupReconciliation(): void;
  /** Clear reconciliation state for a session (call on unregister). */
  clearSession(sessionId: string): void;
  /**
   * Convergence-aware buffer cleanup across every known buffer dir.
   * Deletes tombstoned sessions' buffers immediately; deletes converged
   * buffers of closed sessions past STALE_BUFFER_MAX_AGE_MS; NEVER
   * deletes a diverging buffer (P3 adds the hard retention cap).
   */
  cleanStaleBuffers(excludeSessionId?: string): number;
  /**
   * True when the session has a non-empty buffer file that this daemon
   * lifetime has not converged. The dead-session sweep consults this to
   * defer deleting a zero-batch session whose buffer may still replay.
   */
  hasUnconvergedBuffer(sessionId: string): boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a reconciler instance bound to the given buffer directory and logger.
 *
 * The returned object exposes `reconcileSession`, `replayEvent`, and
 * `runStartupReconciliation` — all of which share the internal
 * `reconciledSessions` set so that each session is only reconciled once
 * per daemon lifetime.
 */
export function createReconciler({ bufferDirs, logger, projectRoot, onSessionReconciled, eventDedupCache, registry, machineId, resolveGroveDb }: ReconcilerDeps): Reconciler {
  // Track sessions already reconciled this daemon lifetime to avoid
  // redundant file reads (startup scan + register + event can all fire).
  // A session is only added after a pass converges (zero replay errors,
  // unchanged file identity) — failed or aborted passes stay eligible.
  //
  // Keys are bare session ids, deliberately NOT grove-qualified: a session
  // resolves to exactly ONE buffer dir (locateBufferContent takes the
  // first match across dirs), and a mark is only ever written by a pass
  // that ran bound to that dir's Grove DB — so "marked" means "converged
  // IN ITS GROVE DB". Cross-Grove same-id collision would require two
  // UUID session ids to coincide AND would still collapse to the first
  // dir, the reconciler's pre-existing resolution rule.
  const reconciledSessions = new Set<string>();

  // Default Grove-DB resolver: open the Grove's SQLite file directly when
  // it exists (one cached handle per Grove per reconciler lifetime). The
  // daemon overrides this with its GroveRuntimeCache so connections are
  // shared with the HTTP layer. Never CREATES a DB — a registered Grove
  // whose DB hasn't materialized yet is "unavailable" and its dirs are
  // skipped fail-safe rather than written through the ambient singleton.
  const defaultGroveDbHandles = new Map<string, Database>();
  function defaultResolveGroveDb(groveId: string): Database | null {
    const cached = defaultGroveDbHandles.get(groveId);
    if (cached) return cached;
    const dbPath = resolveGroveDbPath(groveId);
    if (!fs.existsSync(dbPath)) return null;
    const db = openDatabase(dbPath);
    defaultGroveDbHandles.set(groveId, db);
    return db;
  }

  type DirScope =
    | { kind: 'unscoped' }
    | { kind: 'scoped'; db: Database }
    | { kind: 'unavailable'; groveId: string };

  /**
   * The DB binding a buffer dir's work must run under. Grove-shaped dir →
   * that Grove's DB ('scoped'), or 'unavailable' when the Grove DB does
   * not exist. Non-Grove-shaped dir (legacy/test layouts) → 'unscoped':
   * run against the ambient `getDatabase()` binding.
   */
  function groveScopeForDir(dir: string): DirScope {
    const identity = bufferDirIdentity(dir);
    if (!identity) return { kind: 'unscoped' };
    const db = (resolveGroveDb ?? defaultResolveGroveDb)(identity.groveId);
    if (!db) return { kind: 'unavailable', groveId: identity.groveId };
    return { kind: 'scoped', db };
  }

  // Sessions whose idle buffer contained unparseable lines that were
  // excluded (converge-with-loss). WARN once per session per daemon
  // lifetime so a persistently-torn file doesn't spam the log.
  const tornLineWarnedSessions = new Set<string>();

  /** Snapshot of the byte-level identity of a buffer file. */
  interface BufferIdentity { size: number; mtimeMs: number }

  function statBufferIdentity(filePath: string): BufferIdentity | null {
    try {
      const stat = fs.statSync(filePath);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  /**
   * Locate the buffer file for a session across all known buffer dirs.
   * Returns the first dir whose buffer file exists and is non-empty, or
   * `null` when no buffer holds this session. The PR #346 invariant —
   * "don't mark reconciled if buffer absent" — lifts cleanly across
   * multiple dirs: a session whose buffer hasn't surfaced in any of them
   * is genuinely absent, and the caller returns without marking it.
   *
   * The file is stat'ed BEFORE it is read; the caller re-stats after the
   * pass and treats any identity change (size or mtime) as "events arrived
   * mid-pass" — the pass is then not considered converged.
   */
  function locateBufferContent(
    sessionId: string,
  ): { dir: string; path: string; content: string; identity: BufferIdentity } | null {
    for (const dir of bufferDirs) {
      const bufferPath = path.join(dir, `${sessionId}.jsonl`);
      const identity = statBufferIdentity(bufferPath);
      if (!identity) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(bufferPath, 'utf-8').trim();
      } catch {
        continue;
      }
      if (raw) return { dir, path: bufferPath, content: raw, identity };
    }
    return null;
  }

  /**
   * Replay a single buffer event into the DB via the appropriate handler.
   *
   * Shared between reconcileSession (buffer replay) and the live /events
   * route to eliminate dispatch duplication.
   *
   * `passCreatedBatchIds` collects the batch ids this reconciliation pass
   * creates (prompt replays) and exempts them from the stop-replay
   * freshness guard — a batch fabricated from buffered history moments ago
   * is not a live turn, even though its created_at is "now".
   *
   * @returns 'prompt' | 'activity' | null indicating what was created.
   */
  function replayEvent(
    sessionId: string,
    event: Record<string, unknown>,
    passCreatedBatchIds?: Set<number>,
  ): 'prompt' | 'activity' | null {
    if (event.type === 'user_prompt') {
      // Live hooks forward `origin` from the manifest decision; pre-v49 buffer
      // files have no `origin` field. Re-evaluate the manifest rule on the
      // prompt text in that case so a buffered <task-notification> /
      // <teammate-message> from before the upgrade still lands with the right
      // origin instead of silently defaulting to 'human'. Forwarded values win.
      const promptText = String(event.prompt ?? '');
      const agent = typeof event.agent === 'string' ? event.agent : undefined;
      if (typeof event.origin === 'string') {
        // Post-rule hooks apply the drop decision BEFORE buffering, so a
        // forwarded origin means the event passed the rules; trust it.
        const { batchId } = handleUserPrompt(sessionId, promptText, { origin: toPromptBatchOrigin(event.origin) });
        passCreatedBatchIds?.add(batchId);
        return 'prompt';
      }
      // Pre-rule buffer (no forwarded origin): re-evaluate the manifest rule
      // with full drop-awareness. A buffered <command-name> / <local-command-
      // stdout> envelope must be DROPPED here too — classifyNextPromptOrigin
      // collapses drop→'human', which would re-insert a prompt the user never
      // typed. Honor rewrite as well so a preamble-stripped prompt replays
      // identically to the live path.
      const decision = classifyNextPromptDecision(agent, promptText);
      if (decision.action === 'drop') return null;
      const replayText = decision.action === 'rewrite' ? decision.prompt : promptText;
      const { batchId } = handleUserPrompt(sessionId, replayText, { origin: toPromptBatchOrigin(decision.origin ?? 'human') });
      passCreatedBatchIds?.add(batchId);
      return 'prompt';
    }
    if (event.type === 'tool_use') {
      handleToolUse(
        sessionId,
        typeof event.agent === 'string' ? event.agent : DEFAULT_SYMBIONT_NAME,
        String(event.tool_name ?? ''),
        event.tool_input,
        typeof event.output_preview === 'string' ? event.output_preview : undefined,
        projectRoot,
        typeof event.transcript_path === 'string' ? event.transcript_path : undefined,
      );
      return 'activity';
    }
    if (event.type === 'tool_failure') {
      handleToolFailure(
        sessionId,
        typeof event.agent === 'string' ? event.agent : DEFAULT_SYMBIONT_NAME,
        String(event.tool_name ?? ''),
        event.tool_input,
        typeof event.error === 'string' ? event.error : undefined,
        !!event.is_interrupt,
      );
      return 'activity';
    }
    if (event.type === 'stop') {
      const summary = typeof event.last_assistant_message === 'string'
        ? event.last_assistant_message.trim()
        : '';
      if (!summary) return null;
      const latest = getLatestBatch(sessionId);
      if (!latest || latest.response_summary) return null;
      // Staleness-qualified open-batch guard. A FRESH open batch is a turn
      // that may still be live — a replayed stop landing on it would
      // attribute a buffered assistant message to a turn it may not belong
      // to. A STALE open batch is the missed-Stop shape itself: the Stop is
      // what closes batches, so a turn whose Stop the daemon never received
      // stays open forever — its buffered summary IS the recovery target.
      // Batches THIS pass created are exempt: they were fabricated from
      // buffered history seconds ago (created_at = now, so they'd always
      // read as fresh) but are by construction not live turns — the
      // full-turn-missed shape needs its stop to land on exactly such a
      // batch. Freshness reads the batch's last sign of life: the latest
      // activity row attached to it, falling back to the batch's own
      // created_at. created_at alone would misclassify a long-running live
      // turn (old batch, activities still flowing) as stale; the
      // MAX(timestamp) is a single indexed query on this rare replay-only
      // path. Write the summary only — the batch is deliberately NOT
      // closed here.
      if (latest.ended_at === null && !passCreatedBatchIds?.has(latest.id)) {
        const lastActivitySec = latestActivityTimestampForBatch(latest.id) ?? latest.created_at;
        const lastSignOfLifeSec = Math.max(lastActivitySec, latest.created_at);
        if (Date.now() - lastSignOfLifeSec * MS_PER_SECOND < STOP_REPLAY_OPEN_BATCH_FRESHNESS_MS) {
          return null;
        }
      }
      setResponseSummary(latest.id, summary);
      return 'activity';
    }
    return null;
  }

  /**
   * Second-chance prompt match for the miner tail-rewrite shape ONLY: true
   * when an existing batch's prompt and the buffered text are BOTH at least
   * PROMPT_PREFIX_MATCH_CHARS long and identical across that full window
   * (the same window `findBatchByPromptPrefix` uses for attachment
   * matching). Catches the Stop-time transcript miner rewriting a stored
   * LONG prompt's tail while the buffer holds the original hook-delivered
   * text (or vice versa). Texts shorter than the window are deliberately
   * excluded: they are fully covered by the exact 256-char key, so a
   * mismatch there means a genuinely different — or genuinely repeated —
   * prompt ("continue", "y") that must replay, not be absorbed by an
   * earlier turn's batch. Matches only against the PRE-PASS batch snapshot
   * so a prompt replayed earlier in this pass can't absorb a later genuine
   * same-text turn.
   */
  function hasPrefixMatchedBatch(batches: ReadonlyArray<BatchRow>, bufferedText: string): boolean {
    if (bufferedText.length < PROMPT_PREFIX_MATCH_CHARS) return false;
    const bufferedPrefix = bufferedText.slice(0, PROMPT_PREFIX_MATCH_CHARS);
    for (const batch of batches) {
      const rowPrompt = batch.user_prompt;
      if (!rowPrompt || rowPrompt.length < PROMPT_PREFIX_MATCH_CHARS) continue;
      if (rowPrompt.startsWith(bufferedPrefix)) return true;
    }
    return false;
  }

  /**
   * Tolerant per-line parse with aging. A torn line on a FRESH file (an
   * append may still be in flight) defers the pass — returns `null` so the
   * next trigger retries once the write completes. A torn line on an idle
   * file is permanent damage: exclude it, warn once per session per daemon
   * lifetime, and return what remains.
   */
  function parseBufferEvents(
    sessionId: string,
    located: { path: string; content: string; identity: BufferIdentity },
  ): Array<Record<string, unknown>> | null {
    const allEvents: Array<Record<string, unknown>> = [];
    let tornLines = 0;
    for (const line of located.content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        allEvents.push(JSON.parse(trimmed));
      } catch {
        tornLines++;
      }
    }
    if (tornLines > 0) {
      if (Date.now() - located.identity.mtimeMs < EVENT_DEDUP_WINDOW_MS) {
        logger.debug(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation deferred — unparseable line on a fresh buffer', {
          session_id: sessionId,
          torn_lines: tornLines,
        });
        return null;
      }
      if (!tornLineWarnedSessions.has(sessionId)) {
        tornLineWarnedSessions.add(sessionId);
        logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation: excluding unparseable lines from idle buffer', {
          session_id: sessionId,
          torn_lines: tornLines,
          buffer_path: located.path,
        });
      }
    }
    return allEvents;
  }

  /**
   * Discard a session's buffer file and mark the session converged. The
   * skip-not-resurrect terminal state for tombstoned and gate-rejected
   * sessions: no DB row exists, none will be created, and the buffer must
   * not linger as a resurrection candidate. The mark is only applied when
   * the unlink succeeds — a failed delete leaves the session eligible so
   * the next trigger retries.
   */
  function discardBuffer(sessionId: string, bufferPath: string, reason: string): void {
    try {
      fs.unlinkSync(bufferPath);
    } catch (err) {
      logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation: failed to discard buffer', {
        session_id: sessionId,
        buffer_path: bufferPath,
        reason,
        error: String(err),
      });
      return;
    }
    reconciledSessions.add(sessionId);
    logger.info(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation: buffer discarded without replay', {
      session_id: sessionId,
      buffer_path: bufferPath,
      reason,
    });
  }

  /**
   * Gate-checked resurrection of a session whose row is absent but whose
   * buffer holds replayable events (daemon was down / DB was reset while
   * hooks kept buffering). Two gates run before any row is created:
   *
   *   1. Identity — the (groveId, projectId) the buffer dir encodes must
   *      still be the project's CURRENT registration. A stale dir (project
   *      moved Groves or re-registered under a new id) is skipped with a
   *      WARN and the file left in place: it ages into retention, and P3's
   *      quarantine handles it terminally.
   *   2. Capture gate — the same manifest rules live auto-registration
   *      applies, evaluated from the buffered events' agent +
   *      transcript_path. A DROP is terminal: the buffer is discarded with
   *      no row (refuses gate-rejected sessions buffered by older
   *      bufferOnIgnored-era hooks — Codex ephemeral title sessions,
   *      phantoms — and kills the resurrect↔stop-gate flap).
   *
   * @returns true when the session row was created and convergence should
   *   proceed; false when the pass must stop (buffer discarded or skipped).
   */
  function resurrectSession(
    sessionId: string,
    located: { dir: string; path: string },
    allEvents: ReadonlyArray<Record<string, unknown>>,
    options: { registerInRegistry: boolean },
  ): boolean {
    const registration = bufferDirCurrentRegistration(located.dir);
    if (!registration) {
      logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation: refusing resurrection — buffer dir is not a current project registration', {
        session_id: sessionId,
        buffer_dir: located.dir,
      });
      return false;
    }

    // Gate inputs come from the buffered events: hook-side buffer copies
    // carry transcript_path (eventWithContext); daemon-side appends carry
    // the full event including agent. Use the first event that has what
    // the gate needs.
    const agent = firstStringField(allEvents, 'agent') ?? DEFAULT_SYMBIONT_NAME;
    const transcriptPath = firstStringField(allEvents, 'transcript_path');

    // Fail open on evaluator errors — mirrors the live dispatcher: keeping
    // a noisy session is recoverable, silently losing one is not.
    let decision: { action: 'pass' } | { action: 'drop'; reason?: string };
    try {
      decision = gateEventByCaptureRules({ agent, transcriptPath }).decision;
    } catch (err) {
      logger.error(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation: capture-rules evaluator threw during resurrection', {
        session_id: sessionId,
        agent,
        error: String(err),
      });
      decision = { action: 'pass' };
    }
    if (decision.action === 'drop') {
      logger.info(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation: resurrection refused by capture gate', {
        session_id: sessionId,
        agent,
        reason: decision.reason ?? 'rule',
      });
      discardBuffer(sessionId, located.path, `capture gate: ${decision.reason ?? 'rule'}`);
      return false;
    }

    const startedAt = firstEventTimestampIso(allEvents);
    ensureSession({
      sessionId,
      agent,
      projectId: registration.projectId,
      projectRoot: registration.projectRoot,
      machineId: machineId ?? getTeamMachineId(),
      ...(startedAt ? { startedAt } : {}),
      // Stale resurrections are closed right after convergence: keep them
      // out of the in-memory registry (no unregister ever comes, and
      // registry membership shields a session from the dead sweep).
      registry: options.registerInRegistry && registry ? registry : { register: () => {} },
      logger,
      source: ENSURE_SESSION_SOURCE.RECONCILE,
    });
    logger.info(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation: session resurrected from buffer', {
      session_id: sessionId,
      agent,
      project_id: registration.projectId,
      grove_id: registration.groveId,
    });
    return true;
  }

  /** First event whose `field` is a non-empty string; its value. */
  function firstStringField(
    events: ReadonlyArray<Record<string, unknown>>,
    field: string,
  ): string | undefined {
    for (const event of events) {
      const value = event[field];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return undefined;
  }

  /** ISO timestamp of the first buffered event that carries one. */
  function firstEventTimestampIso(
    events: ReadonlyArray<Record<string, unknown>>,
  ): string | undefined {
    for (const event of events) {
      const ts = eventTimestampMs(event);
      if (ts !== null) return new Date(ts).toISOString();
    }
    return undefined;
  }

  /** Newest replayable buffered event timestamp (ms), if any carries one. */
  function newestReplayableTimestampMs(
    events: ReadonlyArray<Record<string, unknown>>,
  ): number | undefined {
    let newest: number | undefined;
    for (const event of events) {
      if (!REPLAYABLE_EVENT_TYPES.has(String(event.type))) continue;
      const ts = eventTimestampMs(event);
      if (ts !== null && (newest === undefined || ts > newest)) newest = ts;
    }
    return newest;
  }

  /**
   * Reconcile buffer events against DB state for a session by CONTENT.
   *
   * The buffer is the authoritative event log. The DB (prompt_batches +
   * activities) is a derived view. After a daemon restart, the DB may be
   * missing events the daemon didn't process while it was down — and the
   * buffer may hold copies of events the daemon DID process (the hook CLI
   * appends its own copy whenever the daemon's response didn't confirm
   * processing), so position- or count-based divergence misidentifies the
   * replay point whenever the two sides drifted asymmetrically.
   *
   * Convergence instead keys every stored row and every buffer event with
   * the shared content fingerprint (`@myco/capture/dedup.js`) and walks the
   * buffer chronologically: an event whose key still has an unconsumed DB
   * row converged already; everything else replays through the normal
   * handler flow (prompts open batches, tool events attach to the open
   * batch). The session is marked reconciled only when the pass completes
   * with zero replay errors against an unchanged buffer file.
   */
  function reconcileSession(sessionId: string): void {
    if (reconciledSessions.has(sessionId)) return;

    // Locate the session's buffer across every known dir. Buffer file
    // absent in every dir → return WITHOUT marking reconciled so a later
    // call (after the buffer appears) can replay it.
    const located = locateBufferContent(sessionId);
    if (!located) return;

    // Bind the whole pass to the Grove DB that OWNS the located buffer
    // dir. At boot the ambient DB is the bootstrap/anchor vault — running
    // unbound there made every Grove session's tombstone invisible and
    // replayed its events into the anchor. On the live path the HTTP layer
    // already bound the request's Grove DB; rebinding resolves the same
    // shared handle (cache hit), so nesting is a no-op.
    const scope = groveScopeForDir(located.dir);
    if (scope.kind === 'unavailable') {
      logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Skipping reconciliation — Grove DB for buffer dir unavailable', {
        session_id: sessionId,
        buffer_dir: located.dir,
        grove_id: scope.groveId,
      });
      return;
    }
    if (scope.kind === 'scoped') {
      withDatabase(scope.db, () => reconcileLocatedSession(sessionId, located));
    } else {
      reconcileLocatedSession(sessionId, located);
    }
  }

  /** The per-session pass body; runs inside the owning Grove's DB scope. */
  function reconcileLocatedSession(
    sessionId: string,
    located: NonNullable<ReturnType<typeof locateBufferContent>>,
  ): void {
    // Four-way discrimination on the session row. Row present → normal
    // convergence. Row absent → tombstone / resurrection / retention.
    let resurrected = false;
    let staleResurrection = false;
    let allEvents: Array<Record<string, unknown>> | null = null;
    if (!getSession(sessionId, ALL_PROJECTS_SCOPE)) {
      // (2) Tombstoned: the row was deliberately deleted through
      // deleteSessionCascade. Skip-not-resurrect — discard the lingering
      // buffer so nothing can replay it, and mark converged.
      if (hasSessionTombstone(sessionId)) {
        discardBuffer(sessionId, located.path, 'session tombstoned');
        return;
      }
      allEvents = parseBufferEvents(sessionId, located);
      if (!allEvents) return;
      // (4) No replayable content: nothing to resurrect. Leave the file
      // for retention (P3 adds the hard cap) without marking reconciled —
      // a row appearing later must stay free to converge.
      if (!allEvents.some((event) => REPLAYABLE_EVENT_TYPES.has(String(event.type)))) {
        logger.debug(LOG_KINDS.LIFECYCLE_RECONCILE, 'Skipping reconciliation — session row absent, no replayable events', {
          session_id: sessionId,
        });
        return;
      }
      // (3) Gate-checked resurrection. A resurrection whose newest event
      // already predates the stale threshold is historical recovery — it
      // will be closed right after convergence and must NOT enter the
      // in-memory registry (nothing will ever unregister it, and registry
      // membership shields sessions from the dead sweep).
      const newestMs = newestReplayableTimestampMs(allEvents);
      staleResurrection = newestMs !== undefined && Date.now() - newestMs > STALE_SESSION_THRESHOLD_MS;
      if (!resurrectSession(sessionId, located, allEvents, { registerInRegistry: !staleResurrection })) return;
      resurrected = true;
    }

    allEvents ??= parseBufferEvents(sessionId, located);
    if (!allEvents) return;

    let replayErrors = 0;

    // DB-side content multiset: every stored prompt and every stored
    // non-bookkeeping activity, keyed with the convergence projections of
    // the shared fingerprint. Multiset (key → count) so N genuine
    // same-text turns consume N matches. Bookkeeping rows (subagent_*,
    // task_completed, compact, stop_failure) come from non-replayable
    // events and must never absorb a tool match.
    const existingBatches = listBatchesBySession(sessionId, {
      scope: ALL_PROJECTS_SCOPE,
      limit: CONVERGENCE_QUERY_LIMIT,
    });
    const dbKeyCounts = new Map<string, number>();
    for (const batch of existingBatches) {
      const key = dedupKeyFromPromptBatch(batch);
      dbKeyCounts.set(key, (dbKeyCounts.get(key) ?? 0) + 1);
    }
    for (const activity of listActivities({
      session_id: sessionId,
      scope: ALL_PROJECTS_SCOPE,
      limit: CONVERGENCE_QUERY_LIMIT,
    })) {
      if (isBookkeepingActivity(activity.tool_name)) continue;
      const key = dedupKeyFromActivity(activity);
      dbKeyCounts.set(key, (dbKeyCounts.get(key) ?? 0) + 1);
    }

    // Match-and-consume chronologically. Three guards apply before a
    // prompt / tool event reaches replayEvent:
    //
    //   1. Intra-buffer collapse — the live dispatcher's content+window
    //      dedup applied over the whole file, so the daemon-appended copy
    //      and the hook CLI's duplicate copy (written whenever the daemon
    //      returns `ignored: 'duplicate'` — see `hooks/send-event.ts`)
    //      count as ONE logical event.
    //   2. Exact content match — the event's convergence key consumes one
    //      unconsumed DB row with the same key. user_prompt events key on
    //      the candidate replay text (the rewritten form the live hook
    //      stored and replay would insert), not the raw buffered text.
    //   3. Second-chance prefix match (user_prompt only) — catches miner
    //      tail-rewrites of LONG prompts where exact text diverged. Skips
    //      WITHOUT consuming a multiset count.
    //
    // Stop events take none of these: they have no DB-row projection and
    // their fingerprint carries no content (every stop in a session shares
    // one key, so collapse would eat a rapid second turn's summary). Each
    // is replayed at its chronological position — after the prompts that
    // precede it — so getLatestBatch resolves the batch the turn actually
    // ended on, including a batch this same pass just recovered. The write
    // is NULL-only idempotent.
    //
    // Replayed activities attach via insertActivityWithBatch's latest-open
    // fallback — recovered-but-possibly-misattributed-across-turns is
    // accepted for P1.
    let promptsRecovered = 0;
    let activitiesRecovered = 0;
    let duplicatesSuppressed = 0;
    let eventsConverged = 0;
    let summariesRecovered = 0;
    const seenKeys = new Map<string, number>();
    const passCreatedBatchIds = new Set<number>();

    for (const event of allEvents) {
      const type = String(event.type);
      if (!REPLAYABLE_EVENT_TYPES.has(type)) continue;

      if (type === 'stop') {
        try {
          if (replayEvent(sessionId, event, passCreatedBatchIds) === 'activity') summariesRecovered++;
        } catch (err) {
          replayErrors++;
          logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation: stop replay failed', {
            session_id: sessionId,
            error: String(err),
          });
        }
        continue;
      }

      const eventWithSession = {
        ...event,
        type,
        session_id: sessionId,
      } as Record<string, unknown> & { type: string; session_id: string };
      const exactKey = eventDedupKey(eventWithSession);
      const ts = eventTimestampMs(event) ?? Date.now();
      const lastSeen = seenKeys.get(exactKey);
      if (lastSeen !== undefined && ts - lastSeen < EVENT_DEDUP_WINDOW_MS) {
        duplicatesSuppressed++;
        continue;
      }
      seenKeys.set(exactKey, ts);

      // Mirror replayEvent's user_prompt gate so a pre-rule event the
      // manifest would DROP neither consumes a DB row nor replays, and so
      // both match layers compare the text replay WOULD insert.
      let candidateText: string | null = null;
      if (type === 'user_prompt') {
        const promptText = String(event.prompt ?? '');
        if (typeof event.origin === 'string') {
          candidateText = promptText;
        } else {
          const decision = classifyNextPromptDecision(
            typeof event.agent === 'string' ? event.agent : undefined,
            promptText,
          );
          if (decision.action === 'drop') continue;
          candidateText = decision.action === 'rewrite' ? decision.prompt : promptText;
        }
      }

      const matchKey = type === 'user_prompt'
        ? convergenceEventKey({ ...eventWithSession, prompt: candidateText ?? '' })
        : convergenceEventKey(eventWithSession);
      const remaining = dbKeyCounts.get(matchKey) ?? 0;
      if (remaining > 0) {
        dbKeyCounts.set(matchKey, remaining - 1);
        eventsConverged++;
        continue;
      }

      if (type === 'user_prompt' && candidateText && hasPrefixMatchedBatch(existingBatches, candidateText)) {
        eventsConverged++;
        continue;
      }

      try {
        const result = replayEvent(sessionId, event, passCreatedBatchIds);
        if (result === 'prompt') promptsRecovered++;
        else if (result === 'activity') activitiesRecovered++;
        // Mirror the replay into the live duplicate cache (replay-time
        // stamp) so a late live POST of the same physical event is
        // rejected by the dispatcher instead of double-inserting.
        if (result !== null) eventDedupCache?.record(exactKey, Date.now());
      } catch (err) {
        replayErrors++;
        logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation: failed to replay event', {
          type,
          error: String(err),
        });
      }
    }

    // Converged only if no replay failed AND the buffer file is byte-
    // identical to the pre-read snapshot (no events arrived mid-pass).
    // Anything else leaves the session eligible for the next trigger.
    const after = statBufferIdentity(located.path);
    const identityUnchanged = after !== null
      && after.size === located.identity.size
      && after.mtimeMs === located.identity.mtimeMs;
    if (replayErrors === 0 && identityUnchanged) {
      reconciledSessions.add(sessionId);
    } else {
      logger.debug(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation pass not converged — session stays eligible', {
        session_id: sessionId,
        replay_errors: replayErrors,
        buffer_changed: !identityUnchanged,
      });
    }

    if (promptsRecovered > 0 || activitiesRecovered > 0 || duplicatesSuppressed > 0 || summariesRecovered > 0) {
      logger.info(LOG_KINDS.LIFECYCLE_RECONCILE, 'Buffer reconciliation complete', {
        session_id: sessionId,
        prompts_recovered: promptsRecovered,
        activities_recovered: activitiesRecovered,
        duplicates_suppressed: duplicatesSuppressed,
        events_converged: eventsConverged,
        summaries_recovered: summariesRecovered,
      });
    }

    // A resurrected session whose newest buffered event predates the
    // stale-session threshold is historical recovery, not a live session:
    // close it through the completion chokepoint immediately so the sweep
    // never sees a zombie active minted by replay. (Such sessions were
    // also kept out of the in-memory registry at resurrection time.)
    if (resurrected && staleResurrection) {
      closeSession(sessionId, epochSeconds());
      logger.info(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation: resurrected session closed as stale', {
        session_id: sessionId,
      });
    }
    tryReEnrich(sessionId);
  }

  /** Invoke `onSessionReconciled` if provided, swallowing + logging any error. */
  function tryReEnrich(sessionId: string): void {
    if (!onSessionReconciled) return;
    try {
      onSessionReconciled(sessionId);
    } catch (err) {
      logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Post-reconcile re-enrichment threw', {
        session_id: sessionId,
        error: String(err),
      });
    }
  }

  /**
   * Retention decision for one buffer file during cleanup:
   *
   *   - tombstoned                      → 'delete' (immediate, any age)
   *   - session closed + converged      → 'age-gated' (>24h mtime)
   *   - anything else (diverging, live,
   *     row-absent-no-tombstone)        → 'retain'
   *
   * A diverging buffer is the only durable copy of unreplayed events and
   * is NEVER deleted here — P3 adds the 7d hard cap + quarantine; for P2
   * such buffers are simply retained.
   */
  function classifyBufferForCleanup(sessionId: string): BufferCleanupDecision {
    if (hasSessionTombstone(sessionId)) return 'delete';
    const row = getSession(sessionId, ALL_PROJECTS_SCOPE);
    if (row && row.status !== 'active' && reconciledSessions.has(sessionId)) return 'age-gated';
    return 'retain';
  }

  /**
   * Convergence-aware buffer cleanup across every known dir. Each dir's
   * classification runs bound to ITS Grove's DB — the classifier reads
   * tombstones and session status, and an ambient binding (the anchor at
   * boot, the requester's Grove on the unregister path) would classify
   * every other Grove's sessions as never-seen → retain. Dirs whose Grove
   * DB is unavailable are skipped (retain everything — fail-safe).
   */
  function cleanBuffers(excludeSessionId?: string): number {
    let totalCleaned = 0;
    for (const dir of bufferDirs) {
      const scope = groveScopeForDir(dir);
      if (scope.kind === 'unavailable') continue;
      const run = () => cleanStaleBuffers(dir, STALE_BUFFER_MAX_AGE_MS, excludeSessionId, classifyBufferForCleanup);
      totalCleaned += scope.kind === 'scoped' ? withDatabase(scope.db, run) : run();
    }
    if (totalCleaned > 0) {
      logger.info(LOG_KINDS.CAPTURE_BUFFER, 'Buffer cleanup complete', { stale_removed: totalCleaned });
    }
    return totalCleaned;
  }

  function hasUnconvergedBuffer(sessionId: string): boolean {
    if (reconciledSessions.has(sessionId)) return false;
    return locateBufferContent(sessionId) !== null;
  }

  /**
   * Run startup reconciliation: converge FIRST, clean SECOND. The old
   * clean-first ordering deleted >24h buffers before replay ever saw them
   * — a daemon that stayed down past the stale window silently destroyed
   * the only copy of unconverged events. Cleanup now only fires after the
   * convergence pass has had its chance, and is convergence-aware: only
   * tombstoned or converged-and-closed sessions' files are eligible.
   */
  function runStartupReconciliation(): void {
    // Reconcile every buffer file across all known dirs. A session shows
    // up at most once even if its buffer lives in only one dir —
    // `reconcileSession` is idempotent across multiple invocations via
    // the `reconciledSessions` set.
    const seen = new Set<string>();
    for (const dir of bufferDirs) {
      for (const sessionId of listBufferSessionIds(dir)) {
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        try {
          reconcileSession(sessionId);
        } catch (err) {
          logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Startup reconciliation failed', { session_id: sessionId, error: String(err) });
        }
      }
    }

    cleanBuffers();
  }

  function clearSession(sessionId: string): void {
    reconciledSessions.delete(sessionId);
  }

  return {
    reconcileSession,
    replayEvent,
    runStartupReconciliation,
    clearSession,
    cleanStaleBuffers: cleanBuffers,
    hasUnconvergedBuffer,
  };
}
