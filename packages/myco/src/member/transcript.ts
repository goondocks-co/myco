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
import { SymbiontRegistry } from '../symbionts/registry.js';
import type { TranscriptTurn } from '../symbionts/adapter.js';
import { canStartRequest, clippedRequestBudget, type HookBudget } from './budget.js';
import { TRANSCRIPT_SLICE_BYTES } from './constants.js';
import {
  attachmentEvent, deriveId, planEvent, planKeyForTag, promptEvent, queuedPromptIdFor, transcriptSegmentEvent, TEXT_MEDIA_TYPE,
  type EnvelopeContext, type OutboundEvent,
} from './envelope.js';
import { readSessionState, updateSessionState, type SessionState, type TranscriptPointer } from './session-state.js';
import type { MemberSpool } from './spool.js';
import type { ServerClient } from './transport.js';

let registry: SymbiontRegistry | undefined;
const adapters = (): SymbiontRegistry => (registry ??= new SymbiontRegistry());

export const sha256Text = (text: string): string => crypto.createHash('sha256').update(text, 'utf-8').digest('hex');

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
}

const firstHeading = (content: string): string | undefined => /^#\s+(.+)$/m.exec(content)?.[1]?.trim();

/**
 * The events the transcript holds that hooks never delivered: prompts not yet
 * captured (by text hash), plan-tag plans from assistant turns, and images.
 * Mutates `state` (captured prompts, plan hashes, attachment keys, parsed
 * size); the caller persists it. A transcript whose size is unchanged since
 * the last parse yields nothing.
 */
export function deriveTranscriptCapture(ctx: EnvelopeContext, transcriptPath: string, state: SessionState): DerivedCapture {
  let content: string;
  let size: number;
  try {
    size = fs.statSync(transcriptPath).size;
    if (state.transcript && state.transcript.path === transcriptPath && state.transcript.parsedSize === size) return { events: [] };
    content = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return { events: [] };
  }
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
    state.prompts[hash] = promptId;
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
          const planKey = planKeyForTag(sessionId, tag, state.planTagCount);
          state.planTagCount += 1;
          state.planHashes[hash] = planKey;
          events.push(planEvent(ctx, { planKey, content: planContent, title: firstHeading(planContent), status: 'active', tags: [tag] }));
        }
      }
    }
    for (const image of turn.images ?? []) {
      let bytes: Buffer;
      try { bytes = Buffer.from(image.data, 'base64'); } catch { continue; }
      if (bytes.byteLength === 0) continue;
      const source = ctx.stage(bytes, image.mediaType);
      if (state.attachmentKeys.includes(source.sha256)) continue;
      state.attachmentKeys.push(source.sha256);
      events.push(attachmentEvent(ctx, {
        blobSource: source,
        attachmentId: deriveId('attachment', sessionId, source.sha256),
        promptId: state.prompts[sha256Text(turn.prompt)],
      }));
    }
  }

  if (state.transcript && state.transcript.path === transcriptPath) state.transcript.parsedSize = size;
  return { events, lastAssistantText };
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
  const persist = (next: TranscriptPointer) => { updateSessionState(spool.dir, sessionId, (s) => { s.transcript = next; }, now()); pointer = next; };
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

    const blob = await client.postBlob(bytes, source.sha256, source.mediaType, clippedRequestBudget(budget, now()));
    if (blob.class !== 'acked') {
      if (blob.class === 'retry') spool.markOffline(now(), blob.retryAfterMs);
      return { shipped, endedBy: blob.class === 'reslice' ? 'refused' : blob.class };
    }
    const event = transcriptSegmentEvent(ctx, { transcriptId: pointer.transcriptId, baseOffset: offset, blobSource: source, originPath: pointer.path });
    const outcome = await client.postEvent(event.envelope, clippedRequestBudget(budget, now()));
    switch (outcome.class) {
      case 'acked':
        spool.clearLatch();
        shipped += 1;
        persist({ ...pointer, nextOffset: outcome.transcript?.size ?? offset + bytes.byteLength });
        continue;
      case 'reslice':
        if (outcome.heldSize === lastReslice) return { shipped, endedBy: 'refused' };
        lastReslice = outcome.heldSize;
        persist({ ...pointer, nextOffset: outcome.heldSize });
        continue;
      case 'retry':
        spool.markOffline(now(), outcome.retryAfterMs);
        return { shipped, endedBy: 'retry' };
      default:
        return { shipped, endedBy: outcome.class };
    }
  }
}
