import { evaluateSessionCaptureRules } from './capture-rules.js';
import { readTranscriptMeta } from './transcript-meta.js';
import { gitFacts } from '../member/git-facts.js';
import { hookCwd, runMemberHook, type HookMainOptions, type HookRun } from '../member/capture.js';
import { sessionStartEvent, type OutboundEvent } from '../member/envelope.js';
import { withNotice } from '../member/delivery-notice.js';
import { compactionStart, recordCompaction } from '../member/compaction.js';
import { projectLineOnly, renderedBlock, type ContextAsk, type SessionBlockKind } from '../member/context-cache.js';
import { BLOCK_JOIN } from '@goondocks/myco-shared/recall';
import { readSessionState } from '../member/session-state.js';
import { sessionLineage } from '../member/transcript.js';
import { TRANSCRIPT_PROMPTS_AGENT } from '../member/transcript-prompts.js';
import { sessionInjectionKind } from '@goondocks/myco-shared/recall';
import { isCompactionOrdinal } from '@goondocks/myco-shared/recall';
import { HOOK_CONFIG } from './hook-config.generated.js';
import type { HookResponse } from './response.js';

export { readAntigravityPromptsFromTranscript } from '../member/transcript-prompts.js';

/**
 * The block served at the session's start (or a compaction's), rendered here (`renderedBlock`), with the branch and
 * the session id under it: each on its own line, separated by a blank line, in the shape the harness receives them
 * in. Served once per session and kind.
 */
function sessionStartBlock(run: HookRun, kind: SessionBlockKind, branch: string | undefined): { response: HookResponse; complete: boolean } | undefined {
  const block = renderedBlock(run.spool.dir, run.credential.projectId, kind);
  if (block === undefined) return undefined;
  const lines = [block.text, ...(branch ? [`Branch:: \`${branch}\``] : []), `Session:: \`${run.sessionId}\``];
  return { response: { additionalContext: lines.join(BLOCK_JOIN) }, complete: block.complete };
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
    // One that has been served this kind already (a resumed session) is served nothing again, and asks nothing.
    const due = HOOK_CONFIG[agent]?.capabilities.sessionStartInjection === true && !readSessionState(run.spool.dir, sessionId).delivered.includes(delivered);
    const served = due ? sessionStartBlock(run, ask.kind === 'compact' ? 'compact' : 'start', git.branch) : undefined;
    const response = served?.response;
    // A harness with no prompt hook writes its prompts only to its transcript: the helper reads them from it.
    const backfill = agent === TRANSCRIPT_PROMPTS_AGENT && transcriptPath ? { transcriptPath, at: run.now() } : undefined;
    return {
      events,
      response,
      // Asked for by the session that renders it: the Deployment's record of having served it names this session.
      ask: due ? ask : undefined,
      notice: HOOK_CONFIG[agent]?.capabilities.sessionStartInjection === true ? withNotice : undefined,
      record: (state) => {
        if (compacted) recordCompaction(state);
        // Delivered once the Deployment's block was; the Project line alone leaves it for a later hook to serve whole.
        const servedAs = served === undefined ? undefined : served.complete ? delivered : projectLineOnly(delivered);
        if (servedAs !== undefined && !state.delivered.includes(servedAs)) state.delivered.push(servedAs);
        if (backfill !== undefined) state.promptBackfill = backfill;
      },
    };
  });
}
