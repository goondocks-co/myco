import { evaluateUserPromptRules, resolveSubagentThread } from './capture-rules.js';
import { readTranscriptMeta } from './transcript-meta.js';
import { runMemberHook, type HookMainOptions, type HookRun } from '../member/capture.js';
import { canStartRequest, subRequestBudget } from '../member/budget.js';
import { deriveId, mintId, planEvent, planKeyForTag, promptEvent, type OutboundEvent } from '../member/envelope.js';
import { readSessionState } from '../member/session-state.js';
import { firstHeading, sha256Text } from '../member/text.js';
import { classifyEventAnswer } from '../member/transport.js';
import type { HookResponse } from './response.js';
import { planTagEnvelopeRegex } from '../plans/tag-envelopes.js';
import { HOOK_CONFIG } from './hook-config.generated.js';

const RECALL_PATH = '/context/prompt';
/** The longest one recall call may take, whatever the hook has left. */
export const RECALL_CAP_MS = 1500;

/**
 * What the Deployment serves this prompt, appended to the `Session::` line
 * after a blank line.
 *
 * The call takes a third of what the hook has left, capped, so the drain that
 * follows it still ships records rather than spooling the turn whole. Anything
 * short of a served block — no room, a timeout, a refusal, an empty answer —
 * leaves the `Session::` line standing alone and writes one line to stderr.
 *
 * The outcome moves the offline latch the way a drain pass does: a dark
 * Deployment is latched here, and an answer clears the latch so the drain that
 * follows is not skipped against a server that has just replied.
 */
function recall(session: string, promptId: string, text: string, response: HookResponse) {
  return async (run: HookRun): Promise<HookResponse | undefined> => {
    if (!canStartRequest(run.budget, run.now())) return undefined;
    const answer = classifyEventAnswer(await run.client.request('POST', RECALL_PATH, {
      body: JSON.stringify({ sessionId: session, promptId, text }),
      headers: { 'content-type': 'application/json' },
      budget: subRequestBudget(run.budget, RECALL_CAP_MS, run.now()),
    }));
    if (answer.class !== 'acked') {
      if (answer.class === 'retry') run.spool.markOffline(run.now(), answer.retryAfterMs);
      process.stderr.write(`[myco] user-prompt-submit: recall skipped (${answer.class})\n`);
      return undefined;
    }
    run.spool.clearLatch();
    const served = typeof answer.body.context === 'string' ? answer.body.context : '';
    if (served.length === 0) return undefined;
    return { ...response, additionalContext: `${response.additionalContext}\n\n${served}` };
  };
}

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('user-prompt-submit', opts, (run) => {
    const { input, sessionId, agent, ctx, spool } = run;
    // `Session::` line matches the daemon's injection format (Branch::, Session::).
    const response = { additionalContext: `Session:: \`${sessionId}\`` };
    const rawPrompt = input.prompt ?? '';
    const transcriptMeta = input.transcriptPath ? readTranscriptMeta(input.transcriptPath) : undefined;
    const decision = evaluateUserPromptRules(agent, {
      prompt: rawPrompt,
      transcriptPath: input.transcriptPath,
      transcriptMeta: transcriptMeta ?? undefined,
    });
    if (decision.action === 'drop') {
      process.stderr.write(`[myco] user-prompt-submit: dropped (${decision.reason ?? 'rule'})\n`);
      return { events: [], response };
    }
    const text = decision.action === 'rewrite' ? decision.prompt : rawPrompt;
    if (decision.action === 'rewrite') {
      process.stderr.write(`[myco] user-prompt-submit: rewritten (${decision.reason ?? 'rule'})\n`);
    }

    // A sub-agent thread's prompt names its parent session's current prompt and its own thread.
    const thread = resolveSubagentThread(agent, transcriptMeta ?? undefined);
    const parentPromptId = thread ? readSessionState(spool.dir, thread.parentSessionId).promptId : undefined;
    const threadId = thread?.threadId ? deriveId('thread', thread.threadId) : undefined;

    const promptId = mintId();
    const hash = sha256Text(text);
    const events: OutboundEvent[] = [promptEvent(ctx, { promptId, text, origin: decision.origin, parentPromptId, threadId, threadLabel: thread?.threadLabel ?? undefined })];
    // A plan a person pasted inside a tag envelope is captured with the prompt.
    // Text a runtime injected around a person's prompt is never scanned: a
    // system reminder that quotes a plan is not a plan.
    const plans: Array<[string, string]> = [];
    if (decision.origin === undefined || decision.origin === 'human') {
      const state = readSessionState(spool.dir, sessionId);
      let position = state.planTagCount;
      for (const tag of HOOK_CONFIG[agent]?.planTags ?? []) {
        const regex = planTagEnvelopeRegex(tag);
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          const planContent = match[1].trim();
          if (!planContent) continue;
          const planHash = sha256Text(planContent);
          if (state.planHashes[planHash] || plans.some(([h]) => h === planHash)) continue;
          const planKey = planKeyForTag(sessionId, tag, position);
          position += 1;
          plans.push([planHash, planKey]);
          events.push(planEvent(ctx, { planKey, content: planContent, title: firstHeading(planContent), status: 'active', originPath: `transcript:${tag}`, tags: [tag], promptId }));
        }
      }
    }
    return {
      events,
      // The receipt lands with the event: recorded first, a crash in between
      // would leave the transcript pass skipping this prompt by hash forever.
      record: (state) => {
        state.promptId = promptId;
        state.prompts[hash] = promptId;
        for (const [planHash, planKey] of plans) state.planHashes[planHash] = planKey;
        state.planTagCount += plans.length;
      },
      response,
      context: recall(sessionId, promptId, text, response),
    };
  });
}
