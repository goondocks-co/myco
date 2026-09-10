import { getMachineId } from '../machine-id.js';
import { runMemberHook, type HookMainOptions, type HookRun } from '../member/capture.js';
import { responseEvent, type OutboundEvent } from '../member/envelope.js';
import { planBackstop, planFilesWritten, planRootFor, planWritesInLines } from '../member/plan-files.js';
import { readSessionState, type SessionState, type TranscriptPointer } from '../member/session-state.js';
import {
  deriveTranscriptCapture, pointerReplaced, shipSessionTranscripts, siblingTranscripts, transcriptPointerFor, unreadTranscriptLines, type DerivedCapture,
} from '../member/transcript.js';
import { transcriptWritesTurnRows } from './turn-rows.js';

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

/** A transcript the member reads plan writes out of: the session's own, or a subagent's beside it. */
interface ReadTranscript {
  path: string;
  pointer: TranscriptPointer;
  /** Where the pointer lives in session state. */
  slot: { role: 'primary' } | { role: 'subagent'; path: string };
}

/**
 * The plan files the transcript deltas record a write into, read from disk
 * now. An agent the Deployment parses has nothing else derived here: its
 * prompts, replies and tool calls are the parse's to write, and only the plan
 * file — which an `Edit` record carries as a diff, never whole — is the
 * member's to read. A subagent's transcript is read the same way: a plan it
 * wrote is the session's plan. The receipt is the byte each read stopped at,
 * so a killed hook re-reads the same delta and a finished one never reads it
 * again.
 */
function derivePlanWrites(run: HookRun, transcripts: readonly ReadTranscript[], state: SessionState, root: string): DerivedCapture & { captured: string[] } {
  const written: string[] = [];
  const advances: Array<[ReadTranscript, number]> = [];
  for (const transcript of transcripts) {
    const unread = unreadTranscriptLines(transcript.path, transcript.pointer);
    if (unread === null) continue;
    for (const file of planWritesInLines(run.agent, unread.lines, root)) if (!written.includes(file)) written.push(file);
    advances.push([transcript, unread.size]);
  }
  const plans = planFilesWritten(run.ctx, state, run.credential.projectId, root, written);
  return {
    ...plans,
    record: (next) => {
      plans.record(next);
      for (const [transcript, size] of advances) {
        const stored = transcript.slot.role === 'primary' ? next.transcript : next.siblings[transcript.slot.path];
        if (stored && stored.transcriptId === transcript.pointer.transcriptId) stored.parsedSize = size;
      }
    },
  };
}

/**
 * The transcript phase shared by Stop and SessionEnd: resolve the transcript
 * pointers (the session's own and the subagent transcripts beside it), derive
 * what the member still reads out of the deltas, and ship segments after the
 * drain. Nothing is written here — the pointers and the derivation's receipts
 * travel back as `record` so they land with the append, because a receipt
 * written first turns a crash into permanent loss: the rerun skips by hash
 * and by parsed size.
 */
export function transcriptPhase(run: HookRun): TranscriptPhase {
  const { input, sessionId, ctx, spool, credential, agent } = run;
  const transcriptPath = input.transcriptPath;
  const noop: TranscriptPhase = { events: [], record: () => {}, afterDrain: async () => {} };
  if (!transcriptPath) return noop;
  const machineId = getMachineId();
  const state = readSessionState(spool.dir, sessionId);
  const pointer = transcriptPointerFor(transcriptPath, machineId, state.transcript);
  // A file whose head no longer matches the pointer minted over it is a new
  // transcript under an old name: it ships whole under its own id, and what the
  // member had read of its predecessor is read again.
  if (pointer && pointerReplaced(state.transcript, pointer)) {
    process.stderr.write(`[myco] member: transcript ${transcriptPath} was replaced under its path; shipping it as ${pointer.transcriptId}\n`);
  }
  const current = pointer ? { ...state, transcript: pointer } : state;
  const root = planRootFor(credential.root, typeof input.raw.cwd === 'string' ? input.raw.cwd : undefined);
  const siblings = siblingTranscripts(agent, sessionId, transcriptPath)
    .map((file): [string, TranscriptPointer | null] => [file, transcriptPointerFor(file, machineId, state.siblings[file])])
    .filter((entry): entry is [string, TranscriptPointer] => entry[1] !== null);
  const readable: ReadTranscript[] = [
    ...(pointer ? [{ path: transcriptPath, pointer, slot: { role: 'primary' as const } }] : []),
    ...siblings.map(([file, sibling]) => ({ path: file, pointer: sibling, slot: { role: 'subagent' as const, path: file } })),
  ];
  const derived = transcriptWritesTurnRows(agent)
    ? derivePlanWrites(run, readable, current, root)
    : { ...deriveTranscriptCapture(ctx, transcriptPath, current), captured: [] as string[] };
  // Every plan file this session captured is read again: an edit made outside the write hooks still lands.
  const backstop = planBackstop(ctx, state, root, run.budget, run.now, derived.captured);
  // The pointers this hook READ. A stored pointer that changed underneath —
  // another hook committed one while this ran — names a transcript that hook
  // already handled, and is left as it is, the rule `shipTranscriptSegments`
  // documents for the offset.
  const readPrimary = state.transcript?.transcriptId;
  const readSiblings = Object.fromEntries(Object.entries(state.siblings).map(([file, p]) => [file, p.transcriptId]));
  return {
    events: [...derived.events, ...backstop.events],
    lastAssistantText: derived.lastAssistantText,
    record: (next) => {
      if (pointer && (next.transcript === undefined || next.transcript.transcriptId === readPrimary)) {
        next.transcript = next.transcript && next.transcript.transcriptId === pointer.transcriptId ? { ...next.transcript, headHash: next.transcript.headHash ?? pointer.headHash } : pointer;
      }
      for (const [file, sibling] of siblings) {
        const stored = next.siblings[file];
        if (stored !== undefined && stored.transcriptId !== readSiblings[file]) continue;
        next.siblings[file] = stored && stored.transcriptId === sibling.transcriptId ? { ...stored, headHash: stored.headHash ?? sibling.headHash } : sibling;
      }
      derived.record(next);
      backstop.record(next);
    },
    afterDrain: async (r, until) => { await shipSessionTranscripts(r.ctx, r.spool, r.client, r.budget, { now: r.now, until, machineId }); },
  };
}

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('stop', opts, (run) => {
    const phases = new Set(parsePhasesArg(run.argv));
    const events: OutboundEvent[] = [];
    const transcript = phases.has('transcript') ? transcriptPhase(run) : undefined;
    // The transcript already holds this reply for a symbiont that keeps one,
    // and the parse derives it; shipping here would write the turn twice.
    if (phases.has('response') && !transcriptWritesTurnRows(run.agent)) {
      const hookText = typeof run.input.lastResponse === 'string' ? run.input.lastResponse.trim() : '';
      const text = hookText || transcript?.lastAssistantText?.trim() || '';
      if (text) {
        const promptId = readSessionState(run.spool.dir, run.sessionId).promptId;
        events.push(responseEvent(run.ctx, { text, promptId }));
      }
    }
    if (transcript) events.push(...transcript.events);
    return {
      events,
      record: transcript?.record,
      probe: true,
      afterDrain: transcript ? (r) => transcript.afterDrain(r) : undefined,
    };
  });
}
