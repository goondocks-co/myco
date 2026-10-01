import { evaluateSessionCaptureRules } from './capture-rules.js';
import { readTranscriptMeta } from './transcript-meta.js';
import { gitFacts } from '../member/git-facts.js';
import { hookCwd, runMemberHook, type HookMainOptions, type HookRun } from '../member/capture.js';
import { sessionStartEvent, type OutboundEvent } from '../member/envelope.js';
import { withNotice } from '../member/delivery-notice.js';
import { compactionStart, recordCompaction } from '../member/compaction.js';
import { readProjectContext, type ContextAsk, type SessionBlockKind } from '../member/context-cache.js';
import { readSessionState } from '../member/session-state.js';
import { sessionLineage } from '../member/transcript.js';
import { TRANSCRIPT_PROMPTS_AGENT } from '../member/transcript-prompts.js';
import { sessionInjectionKind } from '@goondocks/myco-shared/recall';
import { isCompactionOrdinal } from '@goondocks/myco-shared/recall';
import { HOOK_CONFIG } from './hook-config.generated.js';
import type { HookResponse } from './response.js';

export { readAntigravityPromptsFromTranscript } from '../member/transcript-prompts.js';

/**
 * The block this machine holds for the session's start (or a compaction's), with the branch and the session id under
 * it: each on its own line, separated by a blank line, in the shape the harness receives them in. Served once per
 * session and kind; nothing cached serves nothing.
 */
function cachedBlock(run: HookRun, kind: SessionBlockKind, delivered: string, branch: string | undefined): HookResponse | undefined {
  if (readSessionState(run.spool.dir, run.sessionId).delivered.includes(delivered)) return undefined;
  const blocks = readProjectContext(run.spool.dir).blocks;
  // A compaction restores what the start served: the Deployment composes the two alike.
  const block = kind === 'compact' ? blocks.compact ?? blocks.start : blocks[kind];
  if (block === undefined || block.context.length === 0) return undefined;
  const lines = [block.context, ...(branch ? [`Branch:: \`${branch}\``] : []), `Session:: \`${run.sessionId}\``];
  return { additionalContext: lines.join('\n\n') };
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

    const git = gitFacts(hookCwd(input));

    const lineage = sessionLineage(agent, sessionId, transcriptPath);
    const events: OutboundEvent[] = [sessionStartEvent(ctx, {
      branch: git.branch,
      headSha: git.headSha,
      startedAt: run.now(),
      originPath: typeof input.raw.cwd === 'string' && input.raw.cwd.length > 0 ? input.raw.cwd : process.cwd(),
      parentSessionId: lineage?.parentSessionId,
      parentReason: lineage?.parentReason,
    })];

    // A start the harness fires after compacting is the compaction's own record: the ordinal moves here, under the
    // append lock, and the block served is the compaction's.
    const compacted = compactionStart(run);
    const compaction = compacted ? readSessionState(run.spool.dir, sessionId).compactionOrdinal + 1 : undefined;
    if (compaction !== undefined && !isCompactionOrdinal(compaction)) throw new Error('session compaction ordinal is invalid');
    const named = git.remote ? { remote: git.remote } : {};
    const ask: ContextAsk = compaction !== undefined
      ? { kind: 'compact', compaction, ...named, at: run.now() }
      : { kind: 'start', ...named, at: run.now() };
    const delivered = sessionInjectionKind(ask);
    // A symbiont whose harness discards a SessionStart answer is served nothing, and the helper fetches nothing for it.
    const injects = HOOK_CONFIG[agent]?.capabilities.sessionStartInjection === true;
    const response = injects ? cachedBlock(run, ask.kind === 'compact' ? 'compact' : 'start', delivered, git.branch) : undefined;
    // A harness with no prompt hook writes its prompts only to its transcript: the helper reads them from it.
    const backfill = agent === TRANSCRIPT_PROMPTS_AGENT && transcriptPath ? { transcriptPath, at: run.now() } : undefined;
    return {
      events,
      response,
      ask: injects ? ask : undefined,
      notice: injects ? withNotice : undefined,
      record: (state) => {
        if (compacted) recordCompaction(state);
        if (response !== undefined && !state.delivered.includes(delivered)) state.delivered.push(delivered);
        if (backfill !== undefined) state.promptBackfill = backfill;
      },
    };
  });
}
