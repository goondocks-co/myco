import { SymbiontRegistry } from '../symbionts/registry.js';
import type { SymbiontAdapter } from '../symbionts/adapter.js';
import { PROMPT_PREVIEW_CHARS } from '../constants.js';
import fs from 'node:fs';
import {
  listMainThreadBatchesBySession,
  listBatchesBySessionThread,
  updateBatchKind,
  insertBatchStateless,
  setBatchPromptNumber,
  populateBatchResponses,
  rehomeSystemActivitiesToHumanAnchor,
  normalizePromptForHash,
  PROMPT_PREFIX_MATCH_CHARS,
  BATCH_KIND,
  PROMPT_BATCH_ORIGIN,
  type BatchRow,
  type PromptBatchOrigin,
} from '../db/queries/batches.js';
import { extractUserPromptRecordsWithDrops, type UserPromptRecord } from './prompt-kind.js';
import { epochSeconds, DEFAULT_AGENT_ID } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { createBatchLineage } from '../db/queries/lineage.js';
import { getSession } from '../db/queries/sessions.js';
import { assertGroveProjectId, ALL_PROJECTS_SCOPE, type GroveProjectId } from '@myco/grove/ids.js';
import { readTranscriptMeta } from '../hooks/transcript-meta.js';
import { evaluateSessionCaptureRules, resolveSubagentThread } from '../hooks/capture-rules.js';
import { stripPlanTagEnvelopes } from '../plans/tag-envelopes.js';

function promptPrefix(text: string | null | undefined): string {
  return (text ?? '').slice(0, PROMPT_PREFIX_MATCH_CHARS);
}

/**
 * Bucket batches by prompt prefix. `consume(text)` pops the first batch whose
 * prefix matches, letting callers match transcript order regardless of DB id order.
 */
function buildPrefixBuckets(batches: ReadonlyArray<BatchRow>): {
  consume(text: string): BatchRow | null;
  remaining(): BatchRow[];
} {
  const buckets = new Map<string, BatchRow[]>();
  for (const b of batches) {
    const key = promptPrefix(b.user_prompt);
    const list = buckets.get(key) ?? [];
    list.push(b);
    buckets.set(key, list);
  }
  return {
    consume(text: string) {
      const bucket = buckets.get(promptPrefix(text));
      if (!bucket || bucket.length === 0) return null;
      return bucket.shift() ?? null;
    },
    remaining() {
      return Array.from(buckets.values()).flat();
    },
  };
}

// Re-export TranscriptTurn from its canonical home in symbionts/adapter.ts
export type { TranscriptTurn } from '../symbionts/adapter.js';
import type { TranscriptTurn, TranscriptImage } from '../symbionts/adapter.js';

/** Minimal logger surface the miner needs. `DaemonLogger` satisfies it. */
export interface MinerLogger {
  info(kind: string, message: string, data?: Record<string, unknown>): void;
  warn(kind: string, message: string, data?: Record<string, unknown>): void;
}

/** A matched turn's images, attributed to a batch during mining. */
export interface MinedImageCapture {
  sessionId: string;
  promptBatchId: string;
  promptNumber: number;
  images: TranscriptImage[];
  projectId: GroveProjectId;
}

interface TranscriptConfig {
  /** Additional symbiont adapters to register (useful for testing or custom symbionts) */
  additionalAdapters?: SymbiontAdapter[];
  /** Logger for mining observability (skip decisions, image-capture failures). */
  logger?: MinerLogger;
  /**
   * Plan tag names (merged manifest `capture.planTags`). Plan envelopes are
   * machine-readable payloads the parser synthesizes for plan extraction;
   * they are stripped from every response the miner persists so they never
   * leak into user-facing summaries.
   */
  planTags?: string[];
  /**
   * Sink invoked for each transcript turn whose images were matched to a
   * batch during `reconcileAndAttributeResponses`. The daemon wires this to
   * the shared `captureBatchImages` routine; without it the mining path
   * silently never captured images (Stop was the only entry point).
   */
  captureImages?: (input: MinedImageCapture) => void;
}

export interface ReconcileInput {
  agent: string;
  transcriptPath: string;
}

export interface ReconcileResult {
  reclassified: number;
  /** Batches created during reconciliation to recover prompts the hook dropped. */
  inserted: number;
  errors: string[];
  /**
   * Set when the entire mining pass was skipped because a transcript-level
   * drop rule fired on the transcript's session_meta (e.g. a Codex
   * sub-agent thread whose tool events carry the PARENT session_id with
   * the CHILD transcript_path — mining it would graft the child rollout
   * onto the parent session).
   */
  skippedReason?: string;
  /**
   * Whether this pass actually read the transcript. False when the file could
   * not be opened, and when a transcript-level rule skipped the pass so the
   * content was never mined into this session. Callers that authorize deleting
   * the transcript must require true — an empty mine and an unreadable one are
   * indistinguishable without it.
   */
  readTranscript: boolean;
}

/** Head-bytes sampled to detect in-place overwrite with same inode + size. */
const PARSE_CACHE_FINGERPRINT_BYTES = 256;

/**
 * Bound on the parse cache — daemons are long-lived and each entry holds the
 * full parsed JSONL event array for a transcript. 32 covers concurrent
 * sessions comfortably while keeping the resident set small; the typical
 * steady-state is a handful of active sessions per daemon. LRU eviction keeps
 * hot transcripts resident across reconcile calls.
 */
const PARSE_CACHE_MAX_ENTRIES = 32;

/**
 * `offset` points past the last newline parsed; `inode`+`fingerprint` detect
 * rotation. `reconciledSize` is the file size observed on the last
 * `reconcileBatchKinds` call for this path — when `stat.size` still equals
 * it we can short-circuit because the transcript hasn't grown since we last
 * reconciled against it.
 */
interface ParseCacheEntry {
  inode: number;
  fingerprint: string;
  offset: number;
  events: Array<Record<string, unknown>>;
  reconciledSize: number;
}

/**
 * Bound on the transcript-meta memo. Entries hold the parsed session_meta
 * payload (Codex meta can embed multi-KB base_instructions), so the cap is
 * kept small and the map is cleared wholesale on overflow — the memo is a
 * re-read suppressor, not a correctness mechanism.
 */
const META_MEMO_MAX_ENTRIES = 64;

interface TranscriptMetaMemoEntry {
  agent: string;
  meta: Record<string, unknown> | undefined;
  /** Drop reason from transcript-level rules, or null when mining may proceed. */
  dropReason: string | null;
  /**
   * Sub-agent thread reattribution target. When non-null this transcript is a
   * resolved sub-agent thread: its turns are mined INTO this PARENT session as
   * thread-scoped batches rather than dropped. Derived from the transcript's
   * own meta (never the sessionId argument), so it is a stable property of the
   * file — safe to memoize. Parent-EXISTENCE is checked per reconcile call and
   * deliberately NOT memoized, so a late-registering parent isn't stuck behind
   * a stale skip.
   */
  reattributeTo: string | null;
  /** The sub-agent thread's own id (thread scope for every insert/query). */
  threadId: string | null;
  /** Friendly thread label for display (nickname / agent path segment). */
  threadLabel: string | null;
  /** Origin stamped on every reattributed record (always agent_dispatch when set). */
  originOverride: PromptBatchOrigin | null;
}

export class TranscriptMiner {
  private registry: SymbiontRegistry;
  private logger?: MinerLogger;
  private planTags: string[];
  private captureImages?: (input: MinedImageCapture) => void;
  /**
   * Append-read cache keyed by path; avoids re-parsing the whole transcript
   * per Stop. Bounded LRU: insertion order preserved via Map semantics,
   * touch-on-access moves the entry to the end, eviction pops the head.
   */
  private parseCache = new Map<string, ParseCacheEntry>();
  /**
   * Per-path memo of the transcript's session_meta + transcript-level drop
   * decision. A rollout's session_meta is its immutable first line, so the
   * decision is stable per file; memoizing also keeps the skip log to one
   * line per transcript instead of one per throttled reconcile tick. Only
   * populated when the meta line was actually readable — a not-yet-flushed
   * file must be re-checked on the next pass.
   */
  private metaMemo = new Map<string, TranscriptMetaMemoEntry>();

  constructor(config?: TranscriptConfig) {
    this.registry = new SymbiontRegistry(config?.additionalAdapters);
    this.logger = config?.logger;
    this.planTags = config?.planTags ?? [];
    this.captureImages = config?.captureImages;
  }

  /**
   * Evaluate the manifest's transcript-level drop rules for this transcript
   * (session_start rules keyed on transcript meta — e.g. Codex's
   * `source.subagent` thread-spawn filter and `source: exec` filter).
   * Returns the memoized entry; `dropReason` non-null means the entire
   * mining pass must be skipped for this file.
   */
  private transcriptGate(sessionId: string, input: ReconcileInput): TranscriptMetaMemoEntry {
    const memo = this.metaMemo.get(input.transcriptPath);
    if (memo && memo.agent === input.agent) return memo;

    const meta = readTranscriptMeta(input.transcriptPath) ?? undefined;

    // Sub-agent thread reattribution takes precedence over the drop gate: a
    // transcript whose meta resolves BOTH a parent thread id AND the child's
    // own thread id is mined INTO the parent session as thread-scoped
    // agent_dispatch batches rather than dropped. Requiring the thread id too
    // keeps every reattributed row properly thread-scoped — a null thread_id
    // would leak the rows into the parent's main thread. When the parent
    // resolves but the thread id doesn't (a manifest misconfiguration), fall
    // through to the drop gate, which is the safe main-thread-protecting
    // behavior. `resolveSubagentThread` returns null when this agent declares
    // no `subagentParentPath` or the path doesn't resolve — the exact
    // unresolvable-parent case that must keep dropping.
    const thread = resolveSubagentThread(input.agent, meta);
    let entry: TranscriptMetaMemoEntry;
    if (thread && thread.threadId) {
      entry = {
        agent: input.agent,
        meta,
        dropReason: null,
        reattributeTo: thread.parentSessionId,
        threadId: thread.threadId,
        threadLabel: thread.threadLabel,
        originOverride: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH,
      };
    } else {
      const decision = evaluateSessionCaptureRules(input.agent, {
        transcriptPath: input.transcriptPath,
        transcriptMeta: meta,
      });
      const dropReason = decision.action === 'drop' ? (decision.reason ?? 'transcript-drop-rule') : null;
      entry = {
        agent: input.agent,
        meta,
        dropReason,
        reattributeTo: null,
        threadId: null,
        threadLabel: null,
        originOverride: null,
      };
    }

    // Only memoize once the meta line is readable — before the agent
    // flushes the file, a decision would be premature and sticky.
    if (meta !== undefined) {
      if (this.metaMemo.size >= META_MEMO_MAX_ENTRIES) this.metaMemo.clear();
      this.metaMemo.set(input.transcriptPath, entry);
      // The skip log fires only for a real drop — a reattributed sub-agent
      // thread is mined, not skipped.
      if (entry.dropReason) {
        this.logger?.info(LOG_KINDS.PROCESSOR_TRANSCRIPT, 'Mining skipped — transcript belongs to a dropped class (e.g. subagent thread)', {
          session_id: sessionId,
          transcript_path: input.transcriptPath,
          reason: entry.dropReason,
        });
      }
      // Distinct signal for the "resolvable parent, no thread id" case: it
      // falls through to the same generic drop-gate reason as an ordinary
      // sub-agent-thread drop, which would otherwise look identical to the
      // expected-drop case in logs. This only fires for an agent-format
      // change or manifest misconfiguration (subagentThreadIdPath missing or
      // not resolving) — worth a WARN even though the drop behavior itself
      // is unchanged and still safe.
      if (thread && !thread.threadId) {
        this.logger?.warn(LOG_KINDS.PROCESSOR_TRANSCRIPT, 'Sub-agent transcript has a resolvable parent but no thread id — dropping instead of reattributing (check subagentThreadIdPath)', {
          session_id: sessionId,
          transcript_path: input.transcriptPath,
          parent_session_id: thread.parentSessionId,
        });
      }
    }
    return entry;
  }

  /**
   * Extract all conversation turns for a session.
   * Convenience wrapper — delegates to getAllTurnsWithSource.
   */
  getAllTurns(sessionId: string): TranscriptTurn[] {
    return this.getAllTurnsWithSource(sessionId).turns;
  }

  /**
   * Extract turns using the hook-provided transcript path first (fast, no scanning),
   * then fall back to adapter registry scanning if the path isn't provided.
   */
  getAllTurnsWithSource(sessionId: string, transcriptPath?: string): { turns: TranscriptTurn[]; source: string } {
    // Primary: use the path provided by the hook (no directory scanning needed)
    if (transcriptPath) {
      const result = this.registry.parseTurnsFromPath(transcriptPath);
      if (result) return result;
    }

    // Fallback: scan known agent directories
    const result = this.registry.getTranscriptTurns(sessionId);
    if (result) return result;
    return { turns: [], source: 'none' };
  }

  /**
   * Align prompt_batches rows with the transcript by prompt-prefix + transcript
   * order. Repairs kind/parent drift on existing rows and inserts rows for
   * prompts the hook dropped (e.g., Claude's queued mid-turn prompts).
   */
  public reconcileBatchKinds(sessionId: string, input: ReconcileInput): ReconcileResult {
    // Transcript-level drop gate — BEFORE any parsing or DB work. Codex
    // sub-agent tool events carry the parent session_id with the CHILD
    // rollout's transcript_path; without this gate the child transcript was
    // mined INTO the parent session (foreign kickoff prompts materialized
    // as human batches). The gate kills that class wholesale: a transcript
    // whose session_meta matches a manifest drop rule is never mined.
    const gate = this.transcriptGate(sessionId, input);
    if (gate.dropReason) {
      return { reclassified: 0, inserted: 0, errors: [], skippedReason: gate.dropReason, readTranscript: false };
    }

    // Sub-agent thread reattribution: mine the child rollout INTO the parent
    // session as thread-scoped agent_dispatch batches. The target session and
    // thread id come from the transcript's OWN meta (via the gate), never the
    // sessionId argument — the live-reconcile caller passes the PARENT id with
    // the child transcript path, and a Stop passes the child id; both converge
    // on the same (parent, threadId) target from the file itself.
    const reattribute = gate.reattributeTo != null;
    const targetSessionId = reattribute ? gate.reattributeTo! : sessionId;
    const threadId = reattribute ? gate.threadId : null;
    const threadLabel = reattribute ? gate.threadLabel : null;

    // The parent must already exist — a child mine never materializes it.
    // Checked every call (not memoized) so a late-registering parent unblocks.
    if (reattribute && !getSession(targetSessionId, ALL_PROJECTS_SCOPE)) {
      return { reclassified: 0, inserted: 0, errors: [], skippedReason: 'subagent-parent-missing', readTranscript: false };
    }

    // Short-circuit: if we've already reconciled this transcript at its
    // current size, nothing new to do. The cached `reconciledSize` is only
    // set after a full reconcile pass at that size, so the DB state is
    // already consistent with the events we'd re-parse. Stop fires after
    // the assistant ends a turn, so any new prompts since the last Stop
    // would have grown the file — zero-growth implies zero new work.
    try {
      const stat = fs.statSync(input.transcriptPath);
      const cached = this.parseCache.get(input.transcriptPath);
      if (
        cached
        && cached.reconciledSize === stat.size
        && cached.offset === stat.size
        && cached.inode === Number(stat.ino)
      ) {
        // Refresh LRU position on short-circuit so a quiet-but-active
        // session doesn't get evicted while other transcripts churn.
        this.parseCache.delete(input.transcriptPath);
        this.parseCache.set(input.transcriptPath, cached);
        return { reclassified: 0, inserted: 0, errors: [], readTranscript: true };
      }
    } catch {
      // statSync failure falls through to parseAllEvents, which handles it.
    }

    // The walker receives the transcript meta so per-prompt
    // `transcript_meta_*` rules fire at mining time exactly as at hook time.
    const parsed = this.parseAllEvents(input.transcriptPath);
    const { records, droppedText, noMaskableDropRuleFound } = extractUserPromptRecordsWithDrops(
      input.agent,
      parsed.events,
      input.transcriptPath,
      gate.meta,
      reattribute ? { subagentReattribution: true } : undefined,
    );
    // Distinct signal for a reattribution that structurally can't work: the
    // walker (no logger access) reports back via the flag rather than
    // logging itself. Without this, a future agent whose sub-agent drop
    // rule keys differently than its declared `subagentParentPath` would
    // mine zero rows here with no signal beyond an empty result — identical
    // to "sub-agent turn legitimately produced no prompts."
    if (noMaskableDropRuleFound) {
      this.logger?.warn(LOG_KINDS.PROCESSOR_TRANSCRIPT, 'Sub-agent reattribution active but no maskable drop rule found — records may all drop (check the agent\'s capture rules vs subagentParentPath)', {
        session_id: sessionId,
        transcript_path: input.transcriptPath,
        agent: input.agent,
      });
    }
    // Bucket/reclassify source: a reattribution mine touches ONLY this
    // thread's rows (thread_id = childThreadId); a main-thread mine touches
    // ONLY thread_id IS NULL rows. Neither side can ever see the other's
    // batches, so a 60-char prompt-prefix collision between a thread row and
    // a main-thread prompt can't cross-contaminate via buildPrefixBuckets.
    const batches = reattribute
      ? listBatchesBySessionThread(targetSessionId, threadId!)
      : listMainThreadBatchesBySession(sessionId, { scope: { kind: 'all' } });

    let reclassified = 0;
    let inserted = 0;
    const errors: string[] = [];

    // Prefix bucketing keeps reconcile idempotent when insertion order diverges
    // from transcript order after a recovery insert.
    const buckets = buildPrefixBuckets(batches);
    let currentParentId: string | null = null;
    let currentParentOrigin: PromptBatchOrigin | null = null;

    // content_hash ordinal source: the 0-based occurrence index of each
    // (origin, normalized text) pair in transcript order, advanced for every
    // record (consumed or inserted) so a later genuine repeat gets the next
    // index rather than colliding with the earlier turn.
    const occurrenceByKey = new Map<string, number>();
    const takeOrdinal = (origin: PromptBatchOrigin, text: string): number => {
      const key = `${origin} ${normalizePromptForHash(text)}`;
      const ordinal = occurrenceByKey.get(key) ?? 0;
      occurrenceByKey.set(key, ordinal + 1);
      return ordinal;
    };

    // Resolve a record's effective kind + parent against the open turn.
    // A steering/interrupt record normally nests under the open initial
    // batch. Two cases force it to start its own initial turn instead:
    //   1. No open parent at all (existing behavior).
    //   2. A HUMAN prompt whose only open parent is a non-human batch
    //      (system task-notification / agent_dispatch teammate-message).
    //      A real user prompt must never hang off a background-event batch:
    //      it owns its own turn (and, via the parser, its own response).
    //      Without this, a question queued while the agent was mid-
    //      task-notification became a steering child of that notification.
    const resolveKindParent = (
      kind: string,
      origin: PromptBatchOrigin,
    ): { effectiveKind: string; parent: string | null } => {
      if (kind === BATCH_KIND.INITIAL) return { effectiveKind: BATCH_KIND.INITIAL, parent: null };
      if (currentParentId == null) return { effectiveKind: BATCH_KIND.INITIAL, parent: null };
      // System / agent_dispatch prompts are point-in-time records: they own a
      // top-level initial batch and never nest, exactly as the live
      // handleUserPrompt path classifies them. A mid-turn <task-notification>
      // (walker-classified steering because it isn't at an end_turn boundary)
      // must therefore NOT become a steering child of the human turn — that
      // would diverge from the live row and thread system noise into a human
      // turn's children. Subsumes the old human-under-nonhuman special case.
      if (origin !== PROMPT_BATCH_ORIGIN.HUMAN) {
        return { effectiveKind: BATCH_KIND.INITIAL, parent: null };
      }
      // A human prompt must not nest under a non-human open parent — it owns
      // its own turn.
      if (currentParentOrigin !== PROMPT_BATCH_ORIGIN.HUMAN) {
        return { effectiveKind: BATCH_KIND.INITIAL, parent: null };
      }
      return { effectiveKind: kind, parent: currentParentId };
    };

    for (const record of records) {
      // Advance the positional ordinal for this record's slot BEFORE the
      // consume check so consumed (already-captured) records still occupy
      // their transcript position — otherwise a later genuine repeat would
      // collide with an earlier turn's hash.
      const ordinal = takeOrdinal(record.origin, record.text);
      const existing = buckets.consume(record.text);

      if (existing) {
        const { effectiveKind, parent: wantParent } = resolveKindParent(record.kind, record.origin);
        if (existing.kind !== effectiveKind || existing.parent_prompt_batch_id !== wantParent) {
          updateBatchKind(existing.id, effectiveKind, wantParent);
          reclassified++;
        }
        // Only a HUMAN initial batch becomes the open anchor. A system batch is
        // a point-in-time record that must not steal the steering anchor from
        // the human turn — mirrors the live path, where system prompts are
        // born-closed and never become the open parent.
        if (effectiveKind === BATCH_KIND.INITIAL && record.origin === PROMPT_BATCH_ORIGIN.HUMAN) {
          currentParentId = existing.id;
          currentParentOrigin = record.origin;
        }
        continue;
      }

      const { effectiveKind, parent: parentForNew } = resolveKindParent(record.kind, record.origin);
      if (record.kind !== BATCH_KIND.INITIAL && effectiveKind === BATCH_KIND.INITIAL && currentParentId == null) {
        errors.push(`transcript prompt classified as ${record.kind} with no open parent; inserting as initial instead`);
      }
      const now = epochSeconds();
      const isSystemOrigin = record.origin !== PROMPT_BATCH_ORIGIN.HUMAN;
      const { row: created, created: didInsert } = insertBatchStateless({
        session_id: targetSessionId,
        user_prompt: record.text,
        ordinal,
        started_at: now,
        // System / agent_dispatch batches are born CLOSED point-in-time records,
        // identical to the live handleUserPrompt path. Born OPEN, a miner-created
        // system batch would outrank a closed human batch on
        // insertActivityWithBatch's `(ended_at IS NULL) DESC` sort and could be
        // returned by findOpenParentBatch — defeating the human-anchoring.
        ended_at: isSystemOrigin ? now : undefined,
        created_at: now,
        kind: effectiveKind,
        origin: record.origin,
        parent_prompt_batch_id: effectiveKind === BATCH_KIND.INITIAL ? null : parentForNew,
        // Null for a main-thread mine; the child thread's id + label for a
        // sub-agent reattribution (folds into content_hash so sibling threads
        // never collide — §3.1).
        thread_id: threadId,
        thread_label: threadLabel,
      });
      // On a dedup (didInsert === false) the row already exists with its
      // lineage, so skip the counter and lineage write; the row still serves
      // as the steering anchor below.
      if (didInsert) {
        inserted++;
        try {
          const lineageProjectId = created.project_id ? assertGroveProjectId(created.project_id) : null;
          createBatchLineage(DEFAULT_AGENT_ID, targetSessionId, created.id, now, lineageProjectId);
        } catch { /* lineage best-effort */ }
      }
      // Only a HUMAN initial batch becomes the open anchor (see existing-branch
      // note above) — system batches never claim the steering anchor.
      if (effectiveKind === BATCH_KIND.INITIAL && record.origin === PROMPT_BATCH_ORIGIN.HUMAN) {
        currentParentId = created.id;
        currentParentOrigin = record.origin;
      }
    }

    // Each capture.rules `drop` decision suppresses a transcript prompt the
    // live hook path already captured, so one DB batch is structurally
    // "stranded by design" per drop. Subtract those from the stranded count
    // before warning — otherwise every slash-command dispatch logs a false
    // signal. Prefix matching isn't viable here: the dropped transcript text
    // (e.g., `<command-message>...`) has a different prefix than the
    // hook-stored batch text (`/<name> <args>`), which is the whole reason we
    // drop the transcript peer in the first place.
    const stranded = Math.max(0, buckets.remaining().length - droppedText.length);
    if (stranded > 0) {
      errors.push(`${stranded} DB batch(es) had no matching transcript prompt`);
    }

    // Stateless insert assigns MAX+1; renumber in transcript order for the UI.
    //
    // Stranded batches — batches whose transcript peer was suppressed by a
    // capture.rules `drop` decision (e.g. Claude Code's <command-message>
    // slash-command dispatch envelope, when the live hook captured the
    // raw `/name args` text upstream) — keep their existing prompt_number
    // and the renumber walker MUST step around those slots. Otherwise the
    // walk restarts at 1 and assigns prompt_number=1 to the first matched
    // batch, colliding with the stranded batch that's still at 1.
    //
    // Concretely: in a Claude Code session that begins with /ce-review,
    // batch 3501 (live hook capture, prompt_number=1) has no transcript peer.
    // Without this guard, when the first <task-notification> arrives and
    // produces batch 3502, the renumber walks the post-drop records, matches
    // 3502, and assigns prompt_number=1 — duplicating 3501's number and
    // breaking getLatestBatch's prompt_number-DESC ordering.
    // Skip the renumber pass entirely for a thread mine: prompt_number is a
    // per-session (main-thread) ordering key, and renumbering across threads
    // would collide numbers between the parent's main thread and its sub-agent
    // threads (§3.1). Thread rows are ordered by insertion (rowid), not prompt_number.
    if (!reattribute && inserted > 0) {
      const allBatches = listMainThreadBatchesBySession(sessionId, { scope: { kind: 'all' } });
      const renumber = buildPrefixBuckets(allBatches);
      const reservedNumbers = new Set<number>();
      // First pass: walk records to identify which batches WILL be matched,
      // and reserve every other batch's existing prompt_number as off-limits.
      const matchableIds = new Set<string>();
      const previewBuckets = buildPrefixBuckets(allBatches);
      for (const record of records) {
        const match = previewBuckets.consume(record.text);
        if (match) matchableIds.add(match.id);
      }
      for (const b of allBatches) {
        if (!matchableIds.has(b.id) && b.prompt_number != null) {
          reservedNumbers.add(b.prompt_number);
        }
      }
      // Second pass: assign sequential prompt_numbers to matched batches,
      // skipping reserved slots so stranded batches retain their numbers
      // without collision.
      let nextNumber = 1;
      const advance = () => {
        nextNumber++;
        while (reservedNumbers.has(nextNumber)) nextNumber++;
      };
      while (reservedNumbers.has(nextNumber)) nextNumber++;
      for (const record of records) {
        const match = renumber.consume(record.text);
        if (match && match.prompt_number !== nextNumber) {
          setBatchPromptNumber(match.id, nextNumber);
        }
        if (match) advance();
      }
    }

    // Mark this size as fully reconciled so a subsequent Stop with the same
    // transcript size short-circuits before any DB scan.
    const postCache = this.parseCache.get(input.transcriptPath);
    if (postCache) {
      this.parseCache.delete(input.transcriptPath);
      this.parseCache.set(input.transcriptPath, {
        ...postCache,
        reconciledSize: postCache.offset,
      });
    }

    return { reclassified, inserted, errors, readTranscript: parsed.read };
  }

  /**
   * Reconcile batch kinds AND attribute responses from the transcript in one
   * pass. This is the unit of work that makes capture visible:
   * `reconcileBatchKinds` materializes/reclassifies prompt batches (including
   * queued steering prompts), then the per-turn responses are matched onto
   * those batches by prompt prefix.
   *
   * Stop runs this at turn end; the live path (PostToolUse, throttled) runs it
   * mid-turn so queued prompts and in-flight responses surface in the dashboard
   * during a long continuous turn instead of only at the next Stop. Both paths
   * are idempotent — re-running over an unchanged transcript is a no-op beyond
   * re-writing identical response_summary values.
   *
   * Returns the reconcile result (batches reclassified/inserted) for callers
   * that want to log or short-circuit.
   */
  public reconcileAndAttributeResponses(
    sessionId: string,
    input: ReconcileInput,
  ): ReconcileResult {
    const result = this.reconcileBatchKinds(sessionId, input);
    // A transcript-level drop skips the WHOLE mining pass — attributing
    // responses or images from a dropped-class transcript would graft its
    // content onto the session exactly like the reconcile would have.
    if (result.skippedReason) return result;

    // Mirror the reconcile's reattribution target: responses and images from a
    // sub-agent thread are written to the PARENT session, thread-scoped, so
    // the child's turns never touch the parent's main-thread rows.
    const gate = this.transcriptGate(sessionId, input);
    const reattribute = gate.reattributeTo != null;
    const targetSessionId = reattribute ? gate.reattributeTo! : sessionId;
    const threadId = reattribute ? gate.threadId ?? undefined : undefined;

    const { turns } = this.getAllTurnsWithSource(sessionId, input.transcriptPath);
    // Plan envelopes have had their extraction chance by the time a summary
    // is persisted (extraction reads raw parser turns, never persisted
    // summaries) — strip them here so machine-readable plan payloads never
    // reach user-facing response_summary values. Envelope-only responses
    // strip to '' and are filtered, leaving the batch summary untouched.
    const responses = turns
      .filter((t) => t.prompt && t.aiResponse)
      .map((t) => ({ prompt: t.prompt, response: stripPlanTagEnvelopes(t.aiResponse!, this.planTags) }))
      .filter((r) => r.response.trim().length > 0);
    if (responses.length > 0) {
      populateBatchResponses(targetSessionId, responses, threadId);
    }
    // Human-anchoring backstop for tool calls: re-home any activity stranded on
    // a system-origin batch onto its enclosing human turn (legacy data + live
    // races). The live path attributes correctly by construction; this keeps
    // re-mined/older sessions consistent so the myco agent sees the tool calls.
    // Skipped entirely for a thread mine: a thread's batches are all
    // agent_dispatch (no human anchor to re-home onto), and rehoming is
    // main-thread machinery that would reach across into the parent's rows.
    if (!reattribute) {
      rehomeSystemActivitiesToHumanAnchor(sessionId);
    }
    this.captureTurnImages(targetSessionId, turns, threadId);
    return result;
  }

  /**
   * Mining-path image capture: match each image-bearing turn to its batch by
   * prompt prefix (the same matching `populateBatchResponses` uses) and hand
   * the images to the injected sink. Tenancy comes from the matched batch's
   * own project_id — never from ambient daemon state. Best-effort: a sink
   * failure is logged and never blocks reconciliation.
   */
  private captureTurnImages(sessionId: string, turns: TranscriptTurn[], threadId?: string): void {
    if (!this.captureImages) return;
    const imageTurns = turns.filter((t) => t.images?.length && t.prompt);
    if (imageTurns.length === 0) return;

    // Thread-scoped when mining a sub-agent thread so images match only that
    // thread's batches; main-thread scoped otherwise so a thread row can
    // never absorb a main-thread image match.
    const batches = threadId != null
      ? listBatchesBySessionThread(sessionId, threadId)
      : listMainThreadBatchesBySession(sessionId, { scope: { kind: 'all' } });
    const buckets = buildPrefixBuckets(batches);
    for (let i = 0; i < imageTurns.length; i++) {
      const turn = imageTurns[i]!;
      const match = buckets.consume(turn.prompt);
      if (!match?.project_id) continue;
      try {
        this.captureImages({
          sessionId,
          promptBatchId: match.id,
          promptNumber: match.prompt_number ?? i + 1,
          images: turn.images!,
          projectId: assertGroveProjectId(match.project_id),
        });
      } catch (err) {
        this.logger?.warn(LOG_KINDS.PROCESSOR_TRANSCRIPT, 'Mining-path image capture failed', {
          session_id: sessionId,
          batch_id: match.id,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Parse the whole transcript. `read` distinguishes "the file was opened and
   * yielded these events" from "the file could not be read at all" — an empty
   * array means nothing on its own, and callers that go on to authorize a
   * delete must not treat an unreadable transcript as a mined-empty one.
   */
  private parseAllEvents(transcriptPath: string): { events: Array<Record<string, unknown>>; read: boolean } {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      return { events: [], read: false };
    }

    const cached = this.parseCache.get(transcriptPath);
    const inode = Number(stat.ino);
    const fingerprint = this.readFromOffset(
      transcriptPath,
      0,
      Math.min(stat.size, PARSE_CACHE_FINGERPRINT_BYTES),
    );

    // Reparse on: no cache, inode change (rotation), shrink (truncation),
    // or head-bytes divergence (in-place overwrite).
    const cacheStale = !cached
      || cached.inode !== inode
      || stat.size < cached.offset
      || cached.fingerprint !== fingerprint;

    if (cacheStale) {
      const fullText = this.readFromOffset(transcriptPath, 0, stat.size);
      const newline = fullText.lastIndexOf('\n');
      const complete = newline === -1 ? '' : fullText.slice(0, newline + 1);
      const events = parseJsonlLines(complete);
      this.storeCacheEntry(transcriptPath, {
        inode,
        fingerprint,
        offset: Buffer.byteLength(complete, 'utf8'),
        events,
        // Reset — reconcile hasn't run against this (possibly rotated) file yet.
        reconciledSize: -1,
      });
      return { events, read: true };
    }

    if (stat.size === cached.offset) {
      // Touch LRU so the entry stays hot while we keep hitting the cache.
      this.parseCache.delete(transcriptPath);
      this.parseCache.set(transcriptPath, cached);
      return { events: cached.events, read: true };
    }

    // Incremental: read bytes added since last parse, up to the last newline.
    const tail = this.readFromOffset(transcriptPath, cached.offset, stat.size - cached.offset);
    const newline = tail.lastIndexOf('\n');
    if (newline === -1) {
      this.parseCache.delete(transcriptPath);
      this.parseCache.set(transcriptPath, cached);
      return { events: cached.events, read: true };
    }

    const complete = tail.slice(0, newline + 1);
    const newEvents = parseJsonlLines(complete);
    const merged = [...cached.events, ...newEvents];
    this.storeCacheEntry(transcriptPath, {
      inode,
      fingerprint,
      offset: cached.offset + Buffer.byteLength(complete, 'utf8'),
      events: merged,
      // New bytes appeared — previous reconciledSize is now stale.
      reconciledSize: cached.reconciledSize,
    });
    return { events: merged, read: true };
  }

  /**
   * Store (or refresh) a parseCache entry, enforcing the LRU bound. Deleting
   * before setting ensures the entry moves to the end of the Map's insertion
   * order; once we exceed the cap we drop the least-recently-used key
   * (Map.keys() yields insertion order).
   */
  private storeCacheEntry(transcriptPath: string, entry: ParseCacheEntry): void {
    this.parseCache.delete(transcriptPath);
    this.parseCache.set(transcriptPath, entry);
    while (this.parseCache.size > PARSE_CACHE_MAX_ENTRIES) {
      const oldest = this.parseCache.keys().next().value;
      if (oldest === undefined) break;
      this.parseCache.delete(oldest);
    }
  }

  private readFromOffset(path: string, offset: number, length: number): string {
    if (length <= 0) return '';
    const fd = fs.openSync(path, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }
}

function parseJsonlLines(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l) as Record<string, unknown>; }
      catch { return {}; }
    });
}

/**
 * Build turns from buffer events — the fallback when no agent transcript is available.
 * Buffer events come from hooks (user_prompt, tool_use) and lack AI responses.
 * Turns will have prompts and tool counts but no aiResponse.
 */
export function extractTurnsFromBuffer(events: Array<Record<string, unknown>>): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;

  for (const event of events) {
    const type = event.type as string;
    if (type === 'user_prompt') {
      if (current) turns.push(current);
      current = {
        prompt: String(event.prompt ?? '').slice(0, PROMPT_PREVIEW_CHARS),
        toolCount: 0,
        timestamp: String(event.timestamp ?? new Date().toISOString()),
      };
    } else if (type === 'tool_use') {
      if (current) current.toolCount++;
    }
  }
  if (current) turns.push(current);
  return turns;
}
