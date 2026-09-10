/**
 * The transcript as the member ships it: bytes from the server-held offset, in
 * segments, for the session's own file and for the subagent transcripts found
 * beside it. The transcript file on disk is the durable copy: only the pointer
 * (identity, next offset, bytes already read) lives in session-state; no
 * transcript byte is ever spooled.
 *
 * For an agent whose hooks still write its turn rows, the transcript is also
 * read here at Stop for what hooks never delivered — queued and steering
 * prompts, plan-tag plans from assistant turns, images as attachments, and
 * session lineage. An agent the Deployment parses has none of that derived
 * here: the parse is the one writer of its turns.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { extractUserPromptRecordsWithDrops } from '../capture/prompt-kind.js';
import { eventsOwnedBySession, findSessionContinuation } from '../capture/session-continuation.js';
import { deriveTranscriptId } from '../capture/transcript-id.js';
import { HOOK_CONFIG } from '../hooks/hook-config.generated.js';
import { readTranscriptMeta } from '../hooks/transcript-meta.js';
import { planTagEnvelopeRegex } from '../plans/tag-envelopes.js';
import { firstHeading, sha256Text } from './text.js';
import { SymbiontRegistry } from '../symbionts/registry.js';
import type { TranscriptTurn } from '../symbionts/adapter.js';
import { canStartRequest, clippedRequestBudget, type HookBudget } from './budget.js';
import { TRANSCRIPT_HEAD_HASH_BYTES, TRANSCRIPT_SLICE_BYTES, type MemberCode } from './constants.js';
import {
  attachmentEvent, deriveId, planEvent, planKeyForTag, promptEvent, queuedPromptIdFor, transcriptSegmentEvent, TEXT_MEDIA_TYPE,
  type EnvelopeContext, type OutboundEvent, type TranscriptRole,
} from './envelope.js';
import { readSessionState, updateSessionState, type SessionState, type TranscriptPointer } from './session-state.js';
import type { MemberSpool } from './spool.js';
import type { ServerClient } from './transport.js';

let registry: SymbiontRegistry | undefined;
const adapters = (): SymbiontRegistry => (registry ??= new SymbiontRegistry());

/** The code the Deployment answers a segment whose head digest disagrees with the one it holds. */
const REPLACED_CODE: MemberCode = 'transcript_replaced';

/** The parsed JSON object of every line that is one. */
export function parseTranscriptLines(content: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch { /* partial or non-JSON line */ }
  }
  return out;
}

/**
 * The transcript pointer for a path.
 *
 * Identity is (machine, path, inode, head digest): a new inode (rotation) or
 * a new path starts over at offset 0 under a new id, and so does a file whose
 * first bytes no longer match the ones its pointer was minted over — truncated
 * and rewritten in place, it keeps its path and inode and is a different
 * transcript. A pointer minted before the file had enough bytes for a digest
 * keeps its id and gains the digest once the file is long enough, so an
 * ordinary append never re-mints a live transcript.
 */
export function transcriptPointerFor(transcriptPath: string, machineId: string, previous?: TranscriptPointer): TranscriptPointer | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return null;
  }
  const inode = Number(stat.ino);
  const headHash = transcriptHeadHash(transcriptPath) ?? undefined;
  if (previous && previous.path === transcriptPath && previous.inode === inode && (previous.headHash === undefined || headHash === undefined || previous.headHash === headHash)) {
    return previous.headHash === undefined && headHash !== undefined ? { ...previous, headHash } : previous;
  }
  return { path: transcriptPath, transcriptId: deriveTranscriptId({ machineId, transcriptPath, inode, headHash }), inode, headHash, nextOffset: 0, parsedSize: 0 };
}

/** Whether `next` is a different transcript under the path `previous` named: a rotation, or a file replaced in place. */
export const pointerReplaced = (previous: TranscriptPointer | undefined, next: TranscriptPointer): boolean =>
  previous !== undefined && previous.path === next.path && previous.transcriptId !== next.transcriptId;

/** A fresh pointer for a file the Deployment reports as replaced under its current identity: minted over the bytes the file holds now, from offset 0. */
export function remintedPointer(pointer: TranscriptPointer, machineId: string): TranscriptPointer | null {
  const fresh = transcriptPointerFor(pointer.path, machineId);
  // The same bytes mint the same id: a file too short for a digest has no second identity to offer.
  return fresh !== null && fresh.transcriptId !== pointer.transcriptId ? fresh : null;
}

/**
 * The subagent transcripts written beside a session's own, as the agent's
 * manifest declares their layout: a glob relative to the transcript's
 * directory, `{sessionId}` substituted, `*` matching one path segment.
 */
export function siblingTranscripts(agent: string, sessionId: string, transcriptPath: string): string[] {
  const pattern = HOOK_CONFIG[agent]?.subagentTranscripts;
  if (pattern === undefined) return [];
  const segments = pattern.split('/').filter((s) => s.length > 0).map((s) => s.split('{sessionId}').join(sessionId));
  let candidates = [path.dirname(transcriptPath)];
  for (const segment of segments) {
    const next: string[] = [];
    for (const dir of candidates) {
      if (!segment.includes('*')) {
        next.push(path.join(dir, segment));
        continue;
      }
      const matcher = new RegExp(`^${segment.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const entry of entries) if (matcher.test(entry)) next.push(path.join(dir, entry));
    }
    candidates = next;
  }
  return candidates.filter((file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  }).sort();
}

/** The predecessor a continuation transcript names, for agents that declare `sessionContinuation`. */
export function sessionLineage(agent: string, sessionId: string, transcriptPath: string | undefined): { parentSessionId: string; parentReason: string } | null {
  const declaration = HOOK_CONFIG[agent]?.sessionContinuation;
  if (!declaration || !transcriptPath) return null;
  let content: string;
  try {
    content = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }
  const found = findSessionContinuation(declaration, sessionId, parseTranscriptLines(content));
  return found ? { parentSessionId: found.parentId, parentReason: found.reason } : null;
}

export interface DerivedCapture {
  events: OutboundEvent[];
  /** The last assistant text the parser saw, for a Stop that carried none. */
  lastAssistantText?: string;
  /**
   * The receipts for `events`: the prompt hashes, plan hashes, attachment keys
   * and parsed size that stop them being derived a second time. Returned
   * rather than written, so the caller can apply them with the append — a
   * receipt that outlives its event is an event nothing will ever derive
   * again.
   */
  record: (state: SessionState) => void;
}

/**
 * The bytes of a transcript past what the member has already read, as parsed
 * lines, with the size they were read at. Nothing when the file is unchanged
 * since the last read.
 */
export function unreadTranscriptLines(transcriptPath: string, state: SessionState): { lines: Array<Record<string, unknown>>; size: number } | null {
  try {
    const size = fs.statSync(transcriptPath).size;
    const from = state.transcript && state.transcript.path === transcriptPath ? state.transcript.parsedSize : 0;
    if (from >= size) return null;
    return { lines: parseTranscriptLines(readSlice(transcriptPath, from, size - from).toString('utf-8')), size };
  } catch {
    return null;
  }
}

/**
 * The events the transcript holds that hooks never delivered, for an agent
 * whose hooks write its turn rows: prompts not yet captured (by text hash),
 * plan-tag plans from assistant turns, and images. `state` is READ — the
 * receipts come back in `record` for the caller to apply with the append. A
 * transcript whose size is unchanged since the last parse yields nothing.
 */
export function deriveTranscriptCapture(ctx: EnvelopeContext, transcriptPath: string, state: SessionState): DerivedCapture {
  const noop = { events: [], record: () => {} };
  let content: string;
  let size: number;
  try {
    size = fs.statSync(transcriptPath).size;
    if (state.transcript && state.transcript.path === transcriptPath && state.transcript.parsedSize === size) return noop;
    content = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return noop;
  }
  const capturedPrompts: Array<[string, string]> = [];
  const capturedPlans: Array<[string, string]> = [];
  const capturedAttachments: string[] = [];
  let planTagCount = state.planTagCount;
  const { agent, sessionId } = ctx;
  const events: OutboundEvent[] = [];
  const lines = parseTranscriptLines(content);
  const continuation = HOOK_CONFIG[agent]?.sessionContinuation;
  const owned = continuation ? eventsOwnedBySession(continuation, sessionId, lines) : lines;
  const meta = readTranscriptMeta(transcriptPath) ?? undefined;

  // Prompts the hook path did not capture — queued/steering commands, transcript-only prompts.
  const { records } = extractUserPromptRecordsWithDrops(agent, owned, transcriptPath, meta);
  records.forEach((record, position) => {
    const hash = sha256Text(record.text);
    if (state.prompts[hash]) return;
    const promptId = record.dedupeKey ? queuedPromptIdFor(sessionId, record.dedupeKey) : deriveId('transcript-prompt', sessionId, String(position));
    events.push(promptEvent(ctx, { promptId, text: record.text, origin: record.origin }));
    capturedPrompts.push([hash, promptId]);
  });

  // Plan-tag plans from assistant turns, and images from user turns.
  const adapter = adapters().getAdapter(agent);
  let turns: TranscriptTurn[] = [];
  if (adapter) {
    try { turns = adapter.parseTurns(content); } catch { turns = []; }
  }
  const planTags = HOOK_CONFIG[agent]?.planTags ?? [];
  let lastAssistantText: string | undefined;
  for (const turn of turns) {
    const promptHash = sha256Text(turn.prompt);
    const promptId = state.prompts[promptHash] ?? capturedPrompts.find(([hash]) => hash === promptHash)?.[1];
    if (turn.aiResponse) {
      lastAssistantText = turn.aiResponse;
      for (const tag of planTags) {
        const regex = planTagEnvelopeRegex(tag);
        let match: RegExpExecArray | null;
        while ((match = regex.exec(turn.aiResponse)) !== null) {
          const planContent = match[1].trim();
          if (!planContent) continue;
          const hash = sha256Text(planContent);
          if (state.planHashes[hash]) continue;
          const planKey = planKeyForTag(sessionId, tag, planTagCount);
          planTagCount += 1;
          capturedPlans.push([hash, planKey]);
          events.push(planEvent(ctx, { planKey, content: planContent, title: firstHeading(planContent), status: 'active', originPath: `transcript:${tag}`, tags: [tag], promptId }));
        }
      }
    }
    for (const image of turn.images ?? []) {
      let bytes: Buffer;
      try { bytes = Buffer.from(image.data, 'base64'); } catch { continue; }
      if (bytes.byteLength === 0) continue;
      const source = ctx.stage(bytes, image.mediaType);
      if (state.attachmentKeys.includes(source.sha256) || capturedAttachments.includes(source.sha256)) continue;
      capturedAttachments.push(source.sha256);
      events.push(attachmentEvent(ctx, {
        blobSource: source,
        attachmentId: deriveId('attachment', sessionId, source.sha256),
        promptId,
        originPath: transcriptPath,
      }));
    }
  }

  const record = (next: SessionState): void => {
    for (const [hash, promptId] of capturedPrompts) next.prompts[hash] = promptId;
    for (const [hash, planKey] of capturedPlans) next.planHashes[hash] = planKey;
    for (const key of capturedAttachments) if (!next.attachmentKeys.includes(key)) next.attachmentKeys.push(key);
    next.planTagCount = Math.max(next.planTagCount, planTagCount);
    if (next.transcript && next.transcript.path === transcriptPath) next.transcript.parsedSize = size;
  };
  return { events, lastAssistantText, record };
}

/**
 * The digest of a transcript's first bytes, or null when it has too few.
 *
 * What the Deployment's integrity gate compares a later segment against: a file
 * truncated and rewritten in place keeps its path and its inode, so it keeps
 * its identity, and only the content of its head says it is a different file.
 *
 * Null below the prefix length rather than a digest of what is there: a digest
 * over a partial head would change as the file grew, and every ordinary append
 * would read as a replacement.
 */
export function transcriptHeadHash(filePath: string): string | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (stat.size < TRANSCRIPT_HEAD_HASH_BYTES) return null;
  try {
    const head = readSlice(filePath, 0, TRANSCRIPT_HEAD_HASH_BYTES);
    if (head.byteLength < TRANSCRIPT_HEAD_HASH_BYTES) return null;
    return crypto.createHash('sha256').update(head).digest('hex');
  } catch {
    return null;
  }
}

export interface ShipResult {
  shipped: number;
  endedBy: 'done' | 'budget' | 'retry' | 'parked' | 'refused' | 'unauthorized' | 'route_missing' | 'protocol' | 'absent';
}

const readSlice = (file: string, offset: number, length: number): Buffer => {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
};

/** Which of a session's transcripts a pass ships: the session's own, or the subagent transcript at a path. */
export type TranscriptSlot = { role: 'primary' } | { role: 'subagent'; path: string };
export const PRIMARY_SLOT: TranscriptSlot = { role: 'primary' };

const slotPointer = (state: SessionState, slot: TranscriptSlot): TranscriptPointer | undefined =>
  slot.role === 'primary' ? state.transcript : state.siblings[slot.path];

const setSlotPointer = (state: SessionState, slot: TranscriptSlot, pointer: TranscriptPointer): void => {
  if (slot.role === 'primary') state.transcript = pointer;
  else state.siblings[slot.path] = pointer;
};

/**
 * Ship one of the session's transcripts from its pointer: blob then event per
 * slice (≤ `TRANSCRIPT_SLICE_BYTES`), the server's held size as the next
 * offset, a `reslice` answer re-slicing from the held size, a
 * `transcript_replaced` answer re-minting the pointer over the file's current
 * bytes and starting it over. Stops at the budget, at `until`, or at the first
 * non-ack that is none of those.
 */
export async function shipTranscriptSegments(
  ctx: EnvelopeContext, spool: MemberSpool, client: ServerClient, budget: HookBudget,
  opts: { now?: () => number; until?: number; headHash?: string; slot?: TranscriptSlot; machineId?: string } = {},
): Promise<ShipResult> {
  const now = opts.now ?? Date.now;
  const slot = opts.slot ?? PRIMARY_SLOT;
  const { sessionId } = ctx;
  let pointer = slotPointer(readSessionState(spool.dir, sessionId), slot);
  if (!pointer) return { shipped: 0, endedBy: 'absent' };
  /**
   * Move THIS transcript's offset, computed under the lock against what is
   * stored — never against the snapshot read above. Two rules:
   *
   *   - the stored pointer wins whenever it names another transcript. A
   *     rotation, or a newer pointer another hook commits, describes a
   *     different file; writing this path's offset onto it claims the new
   *     transcript holds bytes that belong to its predecessor.
   *     `transcriptPointerFor` re-detects the new inode and re-ships it from
   *     0 under its own id, which is the correct outcome.
   *   - only `nextOffset` is this path's to write. It takes the value the
   *     server's answer reported and is NOT clamped monotonic: `offset_gap`
   *     moves it BACK to the size the server holds, and that is how a member
   *     that ran ahead recovers.
   *
   * Everything else — the identity fields and `parsedSize`, which the
   * committer owns — is kept as stored, so a stale snapshot cannot regress a
   * value another hook committed while this pass was in flight.
   */
  const persist = (next: TranscriptPointer): boolean => {
    let applied = false;
    updateSessionState(spool.dir, sessionId, (s) => {
      const stored = slotPointer(s, slot);
      if (stored?.transcriptId !== next.transcriptId) return;
      setSlotPointer(s, slot, { ...stored, nextOffset: next.nextOffset });
      applied = true;
    }, now());
    if (applied) pointer = next;
    return applied;
  };
  /** Replace the pointer outright: the Deployment says the file under this identity is not the file it holds. Only while the stored pointer is still the one that was refused. */
  const replace = (replaced: TranscriptPointer, next: TranscriptPointer): boolean => {
    let applied = false;
    updateSessionState(spool.dir, sessionId, (s) => {
      if (slotPointer(s, slot)?.transcriptId !== replaced.transcriptId) return;
      setSlotPointer(s, slot, next);
      applied = true;
    }, now());
    if (applied) pointer = next;
    return applied;
  };
  let shipped = 0;
  let lastReslice = -1;
  let reminted = false;
  for (;;) {
    let size: number;
    try { size = fs.statSync(pointer.path).size; } catch { return { shipped, endedBy: 'absent' }; }
    if (pointer.nextOffset >= size) return { shipped, endedBy: 'done' };
    if (opts.until !== undefined && now() >= opts.until) return { shipped, endedBy: 'budget' };
    if (!canStartRequest(budget, now())) return { shipped, endedBy: 'budget' };

    const offset = pointer.nextOffset;
    const bytes = readSlice(pointer.path, offset, Math.min(TRANSCRIPT_SLICE_BYTES, size - offset));
    if (bytes.byteLength === 0) return { shipped, endedBy: 'done' };
    const source = { path: pointer.path, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mediaType: TEXT_MEDIA_TYPE, size: bytes.byteLength };

    // Built before the upload so both refusal paths can name the segment they lost.
    const event = transcriptSegmentEvent(ctx, {
      transcriptId: pointer.transcriptId, baseOffset: offset, blobSource: source, originPath: pointer.path,
      headHash: opts.headHash ?? pointer.headHash, role: slot.role,
    });
    const logRefusal = (code: MemberCode, reason: string): void => {
      spool.appendRefused({ eventId: event.envelope.eventId, sessionId, kind: event.envelope.kind, code, reason, at: now() });
    };

    const blob = await client.postBlob(bytes, source.sha256, source.mediaType, clippedRequestBudget(budget, now()));
    if (blob.class !== 'acked') {
      // One policy for what an outcome does: the spool's `endPass` owns the
      // latch and the diagnostics, here as much as on the event path — and,
      // as `endPass` documents, the caller logs its own refusal.
      if (blob.class === 'refused') logRefusal(blob.code, blob.reason);
      if (blob.class !== 'reslice') spool.endPass(blob, now());
      return { shipped, endedBy: blob.class === 'reslice' ? 'refused' : blob.class };
    }
    const outcome = await client.postEvent(event.envelope, clippedRequestBudget(budget, now()));
    switch (outcome.class) {
      case 'acked':
        spool.clearLatch();
        shipped += 1;
        // A pointer that no longer names this transcript ends the pass: the
        // session moved on, and whoever moved it ships what it names now.
        if (!persist({ ...pointer, nextOffset: outcome.transcript?.size ?? offset + bytes.byteLength })) return { shipped, endedBy: 'done' };
        continue;
      case 'reslice':
        if (outcome.heldSize === lastReslice) return { shipped, endedBy: 'refused' };
        lastReslice = outcome.heldSize;
        if (!persist({ ...pointer, nextOffset: outcome.heldSize })) return { shipped, endedBy: 'done' };
        continue;
      case 'refused': {
        // The file under this identity is not the one the Deployment holds.
        // Its bytes are a transcript of their own and ship under a fresh id,
        // once: a second disagreement under the fresh id is a refusal.
        const fresh = outcome.code === REPLACED_CODE && !reminted && opts.machineId !== undefined ? remintedPointer(pointer, opts.machineId) : null;
        if (fresh !== null && replace(pointer, fresh)) {
          reminted = true;
          process.stderr.write(`[myco] member: transcript ${pointer.path} was replaced under its identity; shipping it again as ${fresh.transcriptId}\n`);
          continue;
        }
        logRefusal(outcome.code, outcome.reason);
        spool.endPass(outcome, now());
        return { shipped, endedBy: outcome.class };
      }
      default:
        spool.endPass(outcome, now());
        return { shipped, endedBy: outcome.class };
    }
  }
}

/**
 * Ship every transcript the session holds a pointer for: its own, then each
 * subagent transcript beside it, inside one budget. A pass that ends for any
 * reason other than finishing its transcript ends the whole walk: whatever
 * stopped it will stop the next one too.
 */
export async function shipSessionTranscripts(
  ctx: EnvelopeContext, spool: MemberSpool, client: ServerClient, budget: HookBudget,
  opts: { now?: () => number; until?: number; machineId: string },
): Promise<ShipResult> {
  let shipped = 0;
  const state = readSessionState(spool.dir, ctx.sessionId);
  const slots: TranscriptSlot[] = [PRIMARY_SLOT, ...Object.keys(state.siblings).sort().map((p): TranscriptSlot => ({ role: 'subagent', path: p }))];
  for (const slot of slots) {
    const result = await shipTranscriptSegments(ctx, spool, client, budget, { ...opts, slot });
    shipped += result.shipped;
    if (result.endedBy !== 'done' && result.endedBy !== 'absent') return { shipped, endedBy: result.endedBy };
  }
  return { shipped, endedBy: 'done' };
}
