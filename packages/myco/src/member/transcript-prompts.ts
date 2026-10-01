/**
 * Prompts a harness writes only to its transcript, captured by the member helper (#1561): Antigravity has no prompt
 * hook, and writes its transcript after the hook that starts an invocation fires. The hook records where the
 * transcript is (`promptBackfill` in session state); the helper reads the prompts from it and appends each once,
 * under an id derived from its place in the transcript, stamped with the invocation's time, deduplicated by
 * `state.prompts`. A transcript with no prompt in it yet leaves the request for the next pass.
 */
import fs from 'node:fs';
import { AntigravityJsonlParser } from '../symbionts/parsers/antigravity-jsonl.js';
import { deriveId, promptEvent } from './envelope.js';
import { readSessionState } from './session-state.js';
import type { MemberSpool } from './spool.js';
import { sha256Text } from './text.js';

const antigravityParser = new AntigravityJsonlParser();

/** The harness whose prompts are read from its transcript. */
export const TRANSCRIPT_PROMPTS_AGENT = 'antigravity';

/**
 * Read AGY `transcript_full.jsonl` and return the user prompts in order. Empty
 * array on missing/unreadable transcript so callers can no-op.
 */
export function readAntigravityPromptsFromTranscript(transcriptPath: string): string[] {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    return antigravityParser
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
    if (request === undefined) continue;
    const prompts = readAntigravityPromptsFromTranscript(request.transcriptPath);
    if (prompts.length === 0) continue;
    const captured: Array<[string, string]> = [];
    const ctx = { agent: state.agent ?? TRANSCRIPT_PROMPTS_AGENT, sessionId, stage: spool.stagerFor(sessionId), now: () => request.at };
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
