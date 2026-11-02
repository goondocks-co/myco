import { assertMemberTranscriptDestination } from './transcript-routing.js';
/**
 * Prompts a harness writes only to its transcript, captured by the member helper (#1561): a harness whose manifest
 * declares `capture.promptsFromTranscript` has no prompt hook, and writes its transcript after the hook that starts an
 * invocation fires. The hook records where the transcript is (`promptBackfill` in session state); the helper reads the
 * prompts from it with the harness's own parser and appends each once, under an id derived from its place in the
 * transcript, stamped with the invocation's time, deduplicated by canonical prompt id in `state.prompts`. A transcript with no prompt in it
 * yet leaves the request for the next pass.
 */
import { canonicalPromptId } from '@goondocks/myco-shared/prompt-identity';
import fs from 'node:fs';
import { SymbiontRegistry } from '../symbionts/registry.js';
import { deriveId, promptEvent } from './envelope.js';
import { readSessionState } from './session-state.js';
import type { MemberSpool } from './spool.js';

/**
 * The user prompts in a harness's transcript, in order, read by its own parser. Empty on a missing or unreadable
 * transcript, or a harness with no parser, so callers can no-op.
 */
function readPromptTurns(agent: string, transcriptPath: string) {
  const adapter = new SymbiontRegistry().getAdapter(agent);
  if (adapter === undefined) return [];
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    return adapter.parseTurns(content).filter(turn => typeof turn.prompt === 'string' && turn.prompt.length > 0);
  } catch {
    return [];
  }
}

/** The human prompt texts, in the harness's submission order. */
export function readPromptsFromTranscript(agent: string, transcriptPath: string): string[] {
  return readPromptTurns(agent, transcriptPath).map(turn => turn.prompt);
}

/** Append every prompt of each session's requested transcript not captured yet; answers how many were appended. */
export function backfillTranscriptPrompts(spool: MemberSpool, now: () => number): number {
  let appended = 0;
  for (const sessionId of spool.stateSessionIds()) {
    const state = readSessionState(spool.dir, sessionId);
    const request = state.promptBackfill;
    // Only a hook of a harness that names itself asks (`hooks/session-start.ts`): its agent is in the state.
    if (request === undefined || state.agent === undefined) continue;
    assertMemberTranscriptDestination(request.transcriptPath, spool.routing!, spool.mycoHome);
    const agent = state.agent;
    const prompts = readPromptTurns(agent, request.transcriptPath);
    if (prompts.length === 0) continue;
    const captured: string[] = [];
    const known = new Set(Object.values(state.prompts));
    const ctx = { agent, sessionId, stage: spool.stagerFor(sessionId), now: () => request.at };
    const events = prompts.flatMap((turn, position) => {
      const promptId = canonicalPromptId(deriveId, { scheme: 'member-transcript-v1', sessionId, dedupeKey: turn.submissionKey, position });
      if (known.has(promptId)) return [];
      known.add(promptId);
      captured.push(promptId);
      return [promptEvent(ctx, { promptId, text: turn.prompt })];
    });
    spool.appendAndRecord(sessionId, events, (next) => {
      for (const promptId of captured) {
        next.prompts[promptId] = promptId;
        next.promptId = promptId;
      }
      // Read whole: the request is done unless a newer invocation asked again meanwhile.
      if (next.promptBackfill?.at === request.at) delete next.promptBackfill;
    }, now());
    appended += events.length;
  }
  return appended;
}
