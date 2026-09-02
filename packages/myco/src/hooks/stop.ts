import { getMachineId } from '../machine-id.js';
import { runMemberHook, type HookMainOptions, type HookRun } from '../member/capture.js';
import { responseEvent, type OutboundEvent } from '../member/envelope.js';
import { resolveMemberProjectRoot } from '../member/credential.js';
import { planBackstop } from '../member/plan-files.js';
import { readSessionState, type SessionState } from '../member/session-state.js';
import { deriveTranscriptCapture, shipTranscriptSegments, transcriptPointerFor } from '../member/transcript.js';

export type StopPhase = 'response' | 'transcript';
const ALL_PHASES: readonly StopPhase[] = ['response', 'transcript'];

/**
 * Parse `--phases response,transcript` from argv. The hook command generated
 * from a manifest carries the phases this harness event contributes to
 * (Windsurf's response phase vs transcript phase); absent means both.
 */
export function parsePhasesArg(argv: readonly string[]): StopPhase[] {
  const idx = argv.indexOf('--phases');
  if (idx === -1 || idx + 1 >= argv.length) return [...ALL_PHASES];
  const valid = argv[idx + 1].split(',').map((s) => s.trim()).filter((p): p is StopPhase => (ALL_PHASES as readonly string[]).includes(p));
  return valid.length > 0 ? valid : [...ALL_PHASES];
}

export interface TranscriptPhase {
  events: OutboundEvent[];
  lastAssistantText?: string;
  /** The receipts for `events`; applied with the append, never before it. */
  record: (state: SessionState) => void;
  afterDrain: (run: HookRun, until?: number) => Promise<void>;
}

/**
 * The transcript phase shared by Stop and SessionEnd: resolve the transcript
 * pointer, derive the events the transcript holds (queued prompts, plans,
 * images), and ship segments after the drain. Nothing is written here — the
 * pointer and the derivation's receipts travel back as `record` so they land
 * with the append, because a receipt written first turns a crash into
 * permanent loss: the rerun skips by hash and by parsed size.
 */
export function transcriptPhase(run: HookRun): TranscriptPhase {
  const { input, sessionId, ctx, spool } = run;
  const transcriptPath = input.transcriptPath;
  const noop: TranscriptPhase = { events: [], record: () => {}, afterDrain: async () => {} };
  if (!transcriptPath) return noop;
  const state = readSessionState(spool.dir, sessionId);
  const pointer = transcriptPointerFor(transcriptPath, getMachineId(), state.transcript);
  const derived = deriveTranscriptCapture(ctx, transcriptPath, pointer ? { ...state, transcript: pointer } : state);
  return {
    events: derived.events,
    lastAssistantText: derived.lastAssistantText,
    record: (next) => {
      if (pointer) next.transcript = next.transcript && next.transcript.path === pointer.path && next.transcript.inode === pointer.inode ? next.transcript : pointer;
      derived.record(next);
    },
    afterDrain: async (r, until) => { await shipTranscriptSegments(r.ctx, r.spool, r.client, r.budget, { now: r.now, until }); },
  };
}

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('stop', opts, (run) => {
    const phases = new Set(parsePhasesArg(run.argv));
    const events: OutboundEvent[] = [];
    const transcript = phases.has('transcript') ? transcriptPhase(run) : undefined;
    if (phases.has('response')) {
      const hookText = typeof run.input.lastResponse === 'string' ? run.input.lastResponse.trim() : '';
      const text = hookText || transcript?.lastAssistantText?.trim() || '';
      if (text) {
        const promptId = readSessionState(run.spool.dir, run.sessionId).promptId;
        events.push(responseEvent(run.ctx, { text, promptId }));
      }
    }
    if (transcript) events.push(...transcript.events);
    // Every plan file this session shipped is read again: an edit made after the last write hook still lands.
    const state = readSessionState(run.spool.dir, run.sessionId);
    const root = run.credential.root ?? resolveMemberProjectRoot(typeof run.input.raw.cwd === 'string' ? run.input.raw.cwd : undefined);
    const backstop = phases.has('transcript') ? planBackstop(run.ctx, state, root) : undefined;
    if (backstop) events.push(...backstop.events);
    return {
      events,
      record: (next) => { transcript?.record(next); backstop?.record(next); },
      probe: true,
      afterDrain: transcript ? (r) => transcript.afterDrain(r) : undefined,
    };
  });
}
