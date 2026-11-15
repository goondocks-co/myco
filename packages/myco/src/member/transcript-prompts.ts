import { HOOK_CONFIG } from '../hooks/hook-config.generated.js';
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
import { readSessionState, type SessionState } from './session-state.js';
import type { MemberSpool } from './spool.js';

/** Request the transcript-only prompt reader at an invocation or a finalized transcript boundary. */
export function transcriptPromptBackfill(agent: string, transcriptPath: string | undefined, at: number): SessionState['promptBackfill'] {
  return HOOK_CONFIG[agent]?.promptsFromTranscript === true && transcriptPath ? { transcriptPath, at } : undefined;
}

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

/** Capture each transcript prompt once before records refer to it. */
export function captureTranscriptPrompts(spool: MemberSpool, sessionId: string, request: NonNullable<SessionState['promptBackfill']>, now: () => number): number {
  const state = readSessionState(spool.dir, sessionId);
  if (state.agent === undefined) return 0;
  assertMemberTranscriptDestination(request.transcriptPath, spool.routing!, spool.mycoHome);
  const prompts = readPromptTurns(state.agent, request.transcriptPath);
  if (prompts.length === 0) return 0;
  const captured: string[] = [];
  const ctx = { agent: state.agent, sessionId, stage: spool.stagerFor(sessionId), now: () => request.at };
  spool.appendAndRecord(sessionId, next => {
    const known = new Set(Object.values(next.prompts));
    return prompts.flatMap((turn, position) => {
      const promptId = canonicalPromptId(deriveId, { scheme: 'member-transcript-v1', sessionId, dedupeKey: turn.submissionKey, position });
      if (known.has(promptId)) return [];
      known.add(promptId);
      captured.push(promptId);
      return [promptEvent(ctx, { promptId, text: turn.prompt })];
    });
  }, next => {
    for (const promptId of captured) {
      next.prompts[promptId] = promptId;
      next.promptId = promptId;
    }
    if (next.promptBackfill?.at === request.at) delete next.promptBackfill;
  }, now());
  return captured.length;
}

/** Append every requested session's transcript prompts not captured yet. */
export function backfillTranscriptPrompts(spool: MemberSpool, now: () => number): number {
  let appended = 0;
  for (const sessionId of spool.stateSessionIds()) {
    const request = readSessionState(spool.dir, sessionId).promptBackfill;
    if (request !== undefined) appended += captureTranscriptPrompts(spool, sessionId, request, now);
  }
  return appended;
}
