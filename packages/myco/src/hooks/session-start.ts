import fs from 'node:fs';
import { evaluateSessionCaptureRules } from './capture-rules.js';
import { readTranscriptMeta } from './transcript-meta.js';
import { AntigravityJsonlParser } from '../symbionts/parsers/antigravity-jsonl.js';
import { runGit } from '../utils/git.js';
import { runMemberHook, type HookMainOptions } from '../member/capture.js';
import { deriveId, promptEvent, sessionStartEvent, type OutboundEvent } from '../member/envelope.js';
import { updateSessionState } from '../member/session-state.js';
import { sessionLineage, sha256Text } from '../member/transcript.js';

const antigravityParser = new AntigravityJsonlParser();

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

/** Antigravity IDE writes the transcript after PreInvocation fires; one short retry catches the first turn. */
const ANTIGRAVITY_TRANSCRIPT_RETRY_MS = 1500;
async function readAntigravityPromptsWithRetry(transcriptPath: string): Promise<string[]> {
  const first = readAntigravityPromptsFromTranscript(transcriptPath);
  if (first.length > 0) return first;
  await new Promise((resolve) => setTimeout(resolve, ANTIGRAVITY_TRANSCRIPT_RETRY_MS));
  return readAntigravityPromptsFromTranscript(transcriptPath);
}

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('session-start', opts, async (run) => {
    const { input, sessionId, agent, ctx } = run;
    const transcriptPath = input.transcriptPath;
    const transcriptMeta = transcriptPath ? readTranscriptMeta(transcriptPath) : undefined;
    const decision = evaluateSessionCaptureRules(agent, { transcriptPath, transcriptMeta: transcriptMeta ?? undefined });
    if (decision.action === 'drop') {
      process.stderr.write(`[myco] session-start: dropped (${decision.reason ?? 'rule'})\n`);
      return { events: [] };
    }

    let branch: string | undefined;
    try {
      branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], process.cwd());
    } catch { /* not a git repo */ }

    const lineage = sessionLineage(agent, sessionId, transcriptPath);
    const events: OutboundEvent[] = [sessionStartEvent(ctx, {
      branch,
      startedAt: run.now(),
      originPath: typeof input.raw.cwd === 'string' && input.raw.cwd.length > 0 ? input.raw.cwd : process.cwd(),
      parentSessionId: lineage?.parentSessionId,
      parentReason: lineage?.parentReason,
    })];

    // Antigravity has no UserPromptSubmit equivalent: its prompts live in the
    // transcript and are captured here, each once, under a derived id.
    if (agent === 'antigravity' && transcriptPath) {
      const prompts = await readAntigravityPromptsWithRetry(transcriptPath);
      if (prompts.length > 0) {
        updateSessionState(run.spool.dir, sessionId, (state) => {
          prompts.forEach((text, position) => {
            const hash = sha256Text(text);
            if (state.prompts[hash]) return;
            const promptId = deriveId('transcript-prompt', sessionId, String(position));
            state.prompts[hash] = promptId;
            state.promptId = promptId;
            events.push(promptEvent(ctx, { promptId, text }));
          });
        });
      }
    }
    return { events };
  });
}
