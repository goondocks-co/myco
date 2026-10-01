import { evaluateUserPromptRules, resolveSubagentThread } from './capture-rules.js';
import { readTranscriptMeta } from './transcript-meta.js';
import { runMemberHook, type HookMainOptions } from '../member/capture.js';
import { deriveId, mintId, planEvent, planKeyForPromptTag, planKeyForTag, promptEvent, turnEvent, type OutboundEvent } from '../member/envelope.js';
import { featureAdvertised, PROMPT_ASK_MAX_CHARS, readSessionContext } from '../member/context-cache.js';
import { readSessionState } from '../member/session-state.js';
import { firstHeading, sha256Text } from '../member/text.js';
import type { HookResponse } from './response.js';
import { planTagEnvelopeRegex } from '../plans/tag-envelopes.js';
import { HOOK_CONFIG } from './hook-config.generated.js';
import { transcriptWritesTurnRows } from './turn-rows.js';

/**
 * The `Session::` line, with what the Deployment served the session's previous prompt after a blank line: the helper
 * asks with each prompt's text, and the next prompt renders the answer. Each answer is rendered once: while no newer
 * one arrives (the Deployment unreachable, say), the prompts after it are served the line alone. `rendered` names the
 * answer this prompt rendered, recorded with its records.
 */
function withServed(spoolDir: string, sessionId: string, response: HookResponse): { response: HookResponse; rendered?: string } {
  const served = readSessionContext(spoolDir, sessionId).prompt;
  if (served === undefined || served.context.length === 0) return { response };
  if (readSessionState(spoolDir, sessionId).renderedPrompt === served.promptId) return { response };
  return { response: { ...response, additionalContext: `${response.additionalContext}\n\n${served.context}` }, rendered: served.promptId };
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
    // A symbiont whose transcript carries this turn writes no row here and
    // keeps no receipt: the id travels back on the response, a runtime that
    // writes its own transcript stamps it on the turn's lines, and the server's
    // parse is the only writer. Shipping as well would mint a second event for
    // the same row — the ids never meet on the raw insert, so only the
    // projection key hides the duplicate. What this hook does for such a
    // symbiont is inject.
    const transcriptWritesRows = transcriptWritesTurnRows(agent);
    const events: OutboundEvent[] = transcriptWritesRows
      ? []
      : [promptEvent(ctx, { promptId, text, origin: decision.origin, parentPromptId, threadId, threadLabel: thread?.threadLabel ?? undefined })];
    // The turn starts with the person's prompt: a Deployment that takes `turn` is told so, stamped now.
    if (featureAdvertised(spool.dir, 'turn')) events.push(turnEvent(ctx, { phase: 'start', promptId }));
    // A plan a person pasted inside a tag envelope is captured with the prompt,
    // whichever side writes the turn: the Deployment's parse scans assistant
    // text for plans and a pasted one is the person's. It keys on the prompt
    // where the transcript writes the turn, and on the session's own tag count
    // where the hooks do, so it never takes a key the parse also derives. Text
    // a runtime injected around a person's prompt is never scanned: a system
    // reminder that quotes a plan is not a plan.
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
          const planKey = transcriptWritesRows ? planKeyForPromptTag(sessionId, tag, promptId) : planKeyForTag(sessionId, tag, position);
          position += 1;
          plans.push([planHash, planKey]);
          events.push(planEvent(ctx, { planKey, content: planContent, title: firstHeading(planContent), status: 'active', originPath: `transcript:${tag}`, tags: [tag], promptId: transcriptWritesRows ? undefined : promptId }));
        }
      }
    }
    const served = withServed(spool.dir, sessionId, { ...response, promptId });
    return {
      events,
      // The receipt lands with the event: recorded first, a crash in between
      // would leave the transcript pass skipping this prompt by hash forever.
      // A transcript-first symbiont keeps only the plan receipts: its prompt
      // row is the parse's, and the id minted here names no row.
      record: (state) => {
        if (!transcriptWritesRows) {
          state.promptId = promptId;
          state.prompts[hash] = promptId;
          state.planTagCount += plans.length;
        }
        for (const [planHash, planKey] of plans) state.planHashes[planHash] = planKey;
        if (served.rendered !== undefined) state.renderedPrompt = served.rendered;
      },
      response: served.response,
      // The helper asks the Deployment with this prompt's text; its answer is the next prompt's context.
      ask: { kind: 'prompt', promptId, text: text.slice(0, PROMPT_ASK_MAX_CHARS), at: run.now() },
    };
  });
}
