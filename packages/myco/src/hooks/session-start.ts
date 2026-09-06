import fs from 'node:fs';
import { evaluateSessionCaptureRules } from './capture-rules.js';
import { readTranscriptMeta } from './transcript-meta.js';
import { AntigravityJsonlParser } from '../symbionts/parsers/antigravity-jsonl.js';
import { runGit } from '../utils/git.js';
import { runMemberHook, type HookMainOptions, type HookRun } from '../member/capture.js';
import { deriveId, promptEvent, sessionStartEvent, type OutboundEvent } from '../member/envelope.js';
import { servedOnce } from '../member/recall.js';
import { sessionContextRequest } from '../member/compaction.js';
import { readSessionState } from '../member/session-state.js';
import { sessionLineage } from '../member/transcript.js';
import { sha256Text } from '../member/text.js';
import { HOOK_CONFIG } from './hook-config.generated.js';
import type { HookResponse } from './response.js';

const antigravityParser = new AntigravityJsonlParser();

const SESSION_RECALL_PATH = '/context/session';

/**
 * What the Deployment serves this session, with the branch and the session id
 * under it — each on its own line, separated by a blank line, in the shape the
 * harness receives them in.
 *
 * A symbiont whose transcript is written after this hook fires spends up to
 * 1 500 ms waiting for its first turn above, and the seam runs on what the
 * budget has left after that wait.
 */
function recall(sessionId: string, branch: string | undefined) {
  return async (run: HookRun): Promise<HookResponse | undefined> => {
    const request = sessionContextRequest(run);
    if (request === undefined) return undefined;
    const served = await servedOnce(run, SESSION_RECALL_PATH, request);
    if (served === undefined) return undefined;
    const lines = [served, ...(branch ? [`Branch:: \`${branch}\``] : []), `Session:: \`${sessionId}\``];
    return { additionalContext: lines.join('\n\n') };
  };
}

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
    // transcript and are captured here, each once, under a derived id. The
    // receipts travel back with the events so neither can outlive the other.
    const captured: Array<[string, string]> = [];
    if (agent === 'antigravity' && transcriptPath) {
      const seen = readSessionState(run.spool.dir, sessionId).prompts;
      const prompts = await readAntigravityPromptsWithRetry(transcriptPath);
      prompts.forEach((text, position) => {
        const hash = sha256Text(text);
        if (seen[hash] || captured.some(([h]) => h === hash)) return;
        const promptId = deriveId('transcript-prompt', sessionId, String(position));
        captured.push([hash, promptId]);
        events.push(promptEvent(ctx, { promptId, text }));
      });
    }
    return {
      events,
      // A symbiont whose harness discards a SessionStart answer is asked for
      // nothing: the call would spend the hook's budget on a block nobody reads.
      context: HOOK_CONFIG[agent]?.capabilities.sessionStartInjection === true ? recall(sessionId, branch) : undefined,
      record: captured.length === 0 ? undefined : (state) => {
        for (const [hash, promptId] of captured) {
          state.prompts[hash] = promptId;
          state.promptId = promptId;
        }
      },
    };
  });
}
