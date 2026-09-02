/**
 * Transcript-derived capture at Stop/SessionEnd, from the parser alone: the
 * prompts hooks never see (queued/steering commands, transcript-only prompts),
 * plan-tag plans from assistant turns, images as attachments, session lineage
 * for `session.start` — and the transcript bytes themselves as
 * `transcript.segment`s with the server as offset authority. The transcript
 * file on disk is the durable copy: only the pointer (next offset, parsed
 * size) lives in session-state; no transcript byte is ever spooled.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
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
import { TRANSCRIPT_SLICE_BYTES, type MemberCode } from './constants.js';
import {
  attachmentEvent, deriveId, planEvent, planKeyForTag, promptEvent, queuedPromptIdFor, transcriptSegmentEvent, TEXT_MEDIA_TYPE,
  type EnvelopeContext, type OutboundEvent,
} from './envelope.js';
import { readSessionState, updateSessionState, type SessionState, type TranscriptPointer } from './session-state.js';
import type { MemberSpool } from './spool.js';
import type { ServerClient } from './transport.js';

let registry: SymbiontRegistry | undefined;
const adapters = (): SymbiontRegistry => (registry ??= new SymbiontRegistry());

export { sha256Text } from './text.js';

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

/** The transcript pointer for a path: a new inode (rotation) or a new path starts over at offset 0. */
export function transcriptPointerFor(transcriptPath: string, machineId: string, previous?: TranscriptPointer): TranscriptPointer | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return null;
  }
  const inode = Number(stat.ino);
  if (previous && previous.path === transcriptPath && previous.inode === inode) return previous;
  return { path: transcriptPath, transcriptId: deriveTranscriptId({ machineId, transcriptPath, inode }), inode, nextOffset: 0, parsedSize: 0 };
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
 * The events the transcript holds that hooks never delivered: prompts not yet
 * captured (by text hash), plan-tag plans from assistant turns, and images.
 * `state` is READ — the receipts come back in `record` for the caller to apply
 * with the append. A transcript whose size is unchanged since the last parse
 * yields nothing.
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

/**
 * Ship the session's transcript from its pointer: blob then event per slice
 * (≤ `TRANSCRIPT_SLICE_BYTES`), the server's held size as the next offset, a
 * `reslice` answer re-slicing from the held size. Stops at the budget, at
 * `until`, or at the first non-ack that is not a reslice.
 */
export async function shipTranscriptSegments(
  ctx: EnvelopeContext, spool: MemberSpool, client: ServerClient, budget: HookBudget,
  opts: { now?: () => number; until?: number } = {},
): Promise<ShipResult> {
  const now = opts.now ?? Date.now;
  const { sessionId } = ctx;
  let pointer = readSessionState(spool.dir, sessionId).transcript;
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
      if (s.transcript?.transcriptId !== next.transcriptId) return;
      s.transcript = { ...s.transcript, nextOffset: next.nextOffset };
      applied = true;
    }, now());
    if (applied) pointer = next;
    return applied;
  };
  let shipped = 0;
  let lastReslice = -1;
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
    const event = transcriptSegmentEvent(ctx, { transcriptId: pointer.transcriptId, baseOffset: offset, blobSource: source, originPath: pointer.path });
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
      default:
        // The caller logs its own refusal: `endPass` owns the latch and the
        // diagnostics, and only this frame knows which segment was refused.
        if (outcome.class === 'refused') logRefusal(outcome.code, outcome.reason);
        spool.endPass(outcome, now());
        return { shipped, endedBy: outcome.class };
    }
  }
}
