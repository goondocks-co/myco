import { SymbiontRegistry } from '../symbionts/registry.js';
import type { SymbiontAdapter } from '../symbionts/adapter.js';
import { PROMPT_PREVIEW_CHARS } from '../constants.js';
import fs from 'node:fs';
import {
  listBatchesBySession,
  updateBatchKind,
  insertBatchStateless,
  setBatchPromptNumber,
  PROMPT_PREFIX_MATCH_CHARS,
  BATCH_KIND,
  type BatchRow,
} from '../db/queries/batches.js';
import { extractUserPromptRecordsWithDrops, type UserPromptRecord } from './prompt-kind.js';
import { epochSeconds, DEFAULT_AGENT_ID } from '@myco/constants.js';
import { createBatchLineage } from '../db/queries/lineage.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
import { getTeamMachineId } from '../daemon/team-context.js';

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
import type { TranscriptTurn } from '../symbionts/adapter.js';

interface TranscriptConfig {
  /** Additional symbiont adapters to register (useful for testing or custom symbionts) */
  additionalAdapters?: SymbiontAdapter[];
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

export class TranscriptMiner {
  private registry: SymbiontRegistry;
  /**
   * Append-read cache keyed by path; avoids re-parsing the whole transcript
   * per Stop. Bounded LRU: insertion order preserved via Map semantics,
   * touch-on-access moves the entry to the end, eviction pops the head.
   */
  private parseCache = new Map<string, ParseCacheEntry>();

  constructor(config?: TranscriptConfig) {
    this.registry = new SymbiontRegistry(config?.additionalAdapters);
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
        return { reclassified: 0, inserted: 0, errors: [] };
      }
    } catch {
      // statSync failure falls through to parseAllEvents, which handles it.
    }

    const { records, droppedText } = extractUserPromptRecordsWithDrops(
      input.agent,
      this.parseAllEvents(input.transcriptPath),
      input.transcriptPath,
    );
    const batches = listBatchesBySession(sessionId, { scope: { kind: 'all' } }).sort((a, b) => a.id - b.id);

    let reclassified = 0;
    let inserted = 0;
    const errors: string[] = [];

    // Prefix bucketing keeps reconcile idempotent when DB id order diverges
    // from transcript order after a recovery insert.
    const buckets = buildPrefixBuckets(batches);
    let currentParentId: number | null = null;

    for (const record of records) {
      const existing = buckets.consume(record.text);

      if (existing) {
        const wantParent = record.kind === BATCH_KIND.INITIAL ? null : currentParentId;
        if (record.kind !== BATCH_KIND.INITIAL && wantParent == null) {
          errors.push(`batch ${existing.id} classified as ${record.kind} with no open parent`);
          continue;
        }
        if (existing.kind !== record.kind || existing.parent_prompt_batch_id !== wantParent) {
          updateBatchKind(existing.id, record.kind, wantParent);
          reclassified++;
        }
        if (record.kind === BATCH_KIND.INITIAL) currentParentId = existing.id;
        continue;
      }

      const parentForNew = record.kind === BATCH_KIND.INITIAL ? null : currentParentId;
      if (record.kind !== BATCH_KIND.INITIAL && parentForNew == null) {
        errors.push(`transcript prompt classified as ${record.kind} with no open parent; inserting as initial instead`);
      }
      const effectiveKind = record.kind !== BATCH_KIND.INITIAL && parentForNew == null
        ? BATCH_KIND.INITIAL
        : record.kind;
      const now = epochSeconds();
      const created = insertBatchStateless({
        session_id: sessionId,
        user_prompt: record.text,
        started_at: now,
        created_at: now,
        machine_id: getTeamMachineId(),
        kind: effectiveKind,
        origin: record.origin,
        parent_prompt_batch_id: effectiveKind === BATCH_KIND.INITIAL ? null : parentForNew,
      });
      inserted++;
      try {
        const lineageProjectId = created.project_id ? assertGroveProjectId(created.project_id) : null;
        createBatchLineage(DEFAULT_AGENT_ID, sessionId, created.id, now, lineageProjectId);
      } catch { /* lineage best-effort */ }
      if (effectiveKind === BATCH_KIND.INITIAL) currentParentId = created.id;
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
    if (inserted > 0) {
      const allBatches = listBatchesBySession(sessionId, { scope: { kind: 'all' } }).sort((a, b) => a.id - b.id);
      const renumber = buildPrefixBuckets(allBatches);
      const reservedNumbers = new Set<number>();
      // First pass: walk records to identify which batches WILL be matched,
      // and reserve every other batch's existing prompt_number as off-limits.
      const matchableIds = new Set<number>();
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

    return { reclassified, inserted, errors };
  }

  private parseAllEvents(transcriptPath: string): Array<Record<string, unknown>> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      return [];
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
      return events;
    }

    if (stat.size === cached.offset) {
      // Touch LRU so the entry stays hot while we keep hitting the cache.
      this.parseCache.delete(transcriptPath);
      this.parseCache.set(transcriptPath, cached);
      return cached.events;
    }

    // Incremental: read bytes added since last parse, up to the last newline.
    const tail = this.readFromOffset(transcriptPath, cached.offset, stat.size - cached.offset);
    const newline = tail.lastIndexOf('\n');
    if (newline === -1) {
      this.parseCache.delete(transcriptPath);
      this.parseCache.set(transcriptPath, cached);
      return cached.events;
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
    return merged;
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
