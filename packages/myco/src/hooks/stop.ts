import { getMachineId } from '../machine-id.js';
import { runMemberHook, type HookMainOptions, type HookRun } from '../member/capture.js';
import { responseEvent, type OutboundEvent } from '../member/envelope.js';
import { readSessionState, updateSessionState } from '../member/session-state.js';
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

/**
 * The transcript phase shared by Stop and SessionEnd: record the transcript
 * pointer, derive the events the transcript holds (queued prompts, plans,
 * images), and ship segments after the drain. Returns the derived events and
 * the parser's last assistant text.
 */
export function transcriptPhase(run: HookRun): { events: OutboundEvent[]; lastAssistantText?: string; afterDrain: (run: HookRun, until?: number) => Promise<void> } {
  const { input, sessionId, ctx, spool } = run;
  const transcriptPath = input.transcriptPath;
  if (!transcriptPath) return { events: [], afterDrain: async () => {} };
  const events: OutboundEvent[] = [];
  let lastAssistantText: string | undefined;
  updateSessionState(spool.dir, sessionId, (state) => {
    const pointer = transcriptPointerFor(transcriptPath, getMachineId(), state.transcript);
    if (pointer) state.transcript = pointer;
    const derived = deriveTranscriptCapture(ctx, transcriptPath, state);
    events.push(...derived.events);
    lastAssistantText = derived.lastAssistantText;
  }, run.now());
  return {
    events,
    lastAssistantText,
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
    return {
      events,
      probe: true,
      afterDrain: transcript ? (r) => transcript.afterDrain(r) : undefined,
    };
  });
}
