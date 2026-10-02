/**
 * Prompts a harness writes only to its transcript, captured by the member helper (#1561): a harness whose manifest
 * declares `capture.promptsFromTranscript` has no prompt hook, and writes its transcript after the hook that starts an
 * invocation fires. The hook records where the transcript is (`promptBackfill` in session state); the helper reads the
 * prompts from it with the harness's own parser and appends each once, under an id derived from its place in the
 * transcript, stamped with the invocation's time, deduplicated by `state.prompts`. A transcript with no prompt in it
 * yet leaves the request for the next pass.
 */
import fs from 'node:fs';
import { SymbiontRegistry } from '../symbionts/registry.js';
import { deriveId, promptEvent } from './envelope.js';
import { readSessionState } from './session-state.js';
import type { MemberSpool } from './spool.js';
import { sha256Text } from './text.js';

/**
 * The user prompts in a harness's transcript, in order, read by its own parser. Empty on a missing or unreadable
 * transcript, or a harness with no parser, so callers can no-op.
 */
export function readPromptsFromTranscript(agent: string, transcriptPath: string): string[] {
  const adapter = new SymbiontRegistry().getAdapter(agent);
  if (adapter === undefined) return [];
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    return adapter
      .parseTurns(content)
      .map((t) => t.prompt)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
  } catch {
    return [];
  }
}

/** Append every prompt of each session's requested transcript not captured yet; answers how many were appended. */
export function backfillTranscriptPrompts(spool: MemberSpool, now: () => number): number {
  let appended = 0;
  for (const sessionId of spool.stateSessionIds()) {
    const state = readSessionState(spool.dir, sessionId);
    const request = state.promptBackfill;
    // Only a hook of a harness that names itself asks (`hooks/session-start.ts`): its agent is in the state.
    if (request === undefined || state.agent === undefined) continue;
    const agent = state.agent;
    const prompts = readPromptsFromTranscript(agent, request.transcriptPath);
    if (prompts.length === 0) continue;
    const captured: Array<[string, string]> = [];
    const ctx = { agent, sessionId, stage: spool.stagerFor(sessionId), now: () => request.at };
    const events = prompts.flatMap((text, position) => {
      const hash = sha256Text(text);
      if (state.prompts[hash] || captured.some(([h]) => h === hash)) return [];
      const promptId = deriveId('transcript-prompt', sessionId, String(position));
      captured.push([hash, promptId]);
      return [promptEvent(ctx, { promptId, text })];
    });
    spool.appendAndRecord(sessionId, events, (next) => {
      for (const [hash, promptId] of captured) {
        next.prompts[hash] = promptId;
        next.promptId = promptId;
      }
      // Read whole: the request is done unless a newer invocation asked again meanwhile.
      if (next.promptBackfill?.at === request.at) delete next.promptBackfill;
    }, now());
    appended += events.length;
  }
  return appended;
}
