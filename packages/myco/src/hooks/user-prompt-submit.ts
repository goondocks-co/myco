import { evaluateUserPromptRules, resolveSubagentThread } from './capture-rules.js';
import { readTranscriptMeta } from './transcript-meta.js';
import { runMemberHook, type HookMainOptions, type HookOutcome, type HookRun, type OptionalHookCapture } from '../member/capture.js';
import { contextDeliveredEvent, deriveId, mintId, planEvent, planKeyForPromptTag, planKeyForTag, promptEvent, turnEvent, type OutboundEvent } from '../member/envelope.js';
import { featureAdvertised, PROMPT_ASK_MAX_CHARS, promptAnswerKey, readSessionContext, type ContextAsk } from '../member/context-cache.js';
import { readSessionState, type SessionState } from '../member/session-state.js';
import { firstHeading, sha256Text } from '../member/text.js';
import type { HookResponse } from './response.js';
import { planTagEnvelopeRegex } from '../plans/tag-envelopes.js';
import { HOOK_CONFIG } from './hook-config.generated.js';
import { transcriptWritesTurnRows } from './turn-rows.js';
import {
  ASK_IDENTITY_MARKER, canonicalPromptId, hookPromptRequest, PROMPT_IDENTITY_FEATURE, PROMPT_SCHEME_FEATURE, turnGrained,
  type DeliveredSessionRecord, type PromptIdentityDeclaration, type PromptIdScheme, type PromptScopeReason,
} from '@goondocks/myco-shared/prompt-identity';

/**
 * What this submission is named: the id its agent's declaration gives it, with the scheme it is derived by where the
 * Deployment pins schemes, or why it has none. `shared` says the id is the prompt row's own, so a record that names it
 * resolves. A Deployment that does not name `prompt-identity` is asked as before: with an id the hook mints, shared
 * only where the hooks write the rows.
 */
type PromptNaming =
  | { version: 'v1'; promptId: string; scheme?: PromptIdScheme; shared: true }
  | { version: 'v1'; promptId?: undefined; scopeReason: PromptScopeReason; shared: false }
  | { version: 'legacy'; promptId: string; shared: boolean };

/** A turn-grained key's naming, decided under the session's lock: the turn, and the id its opener takes. */
interface TurnKey { turn: string; openerId: string; scheme: PromptIdScheme }

/** What the Deployment names: `v1` asks and delivery, and the pinned schemes a turn-grained key and a named scheme need. */
interface AskFeatures { v1: boolean; schemes: boolean }

function namePrompt(declaration: PromptIdentityDeclaration | undefined, sessionId: string, promptKey: string | undefined, features: AskFeatures, transcriptWritesRows: boolean): PromptNaming | TurnKey {
  if (!features.v1 || declaration === undefined) return { version: 'legacy', promptId: mintId(), shared: !transcriptWritesRows };
  const scheme = features.schemes ? { scheme: declaration.scheme } : {};
  switch (declaration.kind) {
    case 'harness-key': {
      // A key that names a turn names a prompt only where the Deployment pins its transcript to that key's scheme.
      if (turnGrained(declaration.scheme) && !features.schemes) return { version: 'v1', scopeReason: 'transcript_only', shared: false };
      const request = hookPromptRequest(declaration, sessionId, promptKey);
      if (request === null) return { version: 'v1', scopeReason: 'absent_key', shared: false };
      const promptId = canonicalPromptId(deriveId, request);
      return turnGrained(declaration.scheme) ? { turn: promptKey!, openerId: promptId, scheme: declaration.scheme } : { version: 'v1', promptId, ...scheme, shared: true };
    }
    case 'stamped':
    case 'hook-owned':
      return { version: 'v1', promptId: mintId(), ...scheme, shared: true };
    case 'transcript-only':
      return { version: 'v1', scopeReason: 'transcript_only', shared: false };
  }
}

/**
 * A turn-grained submission's naming, from what the session's earlier prompt hooks recorded: the first submission a
 * turn's hooks see that is a person's prompt opens the turn and takes the opener's id; any later one steers it, and
 * the opener's id is no longer the turn's only prompt. A submission that is not a person's prompt names none and
 * opens nothing.
 */
function claimTurn(state: SessionState, key: TurnKey, human: boolean): PromptNaming {
  if (!human) return { version: 'v1', scopeReason: 'steering', shared: false };
  if (state.turn?.id !== key.turn) {
    state.turn = { id: key.turn, promptId: key.openerId };
    return { version: 'v1', promptId: key.openerId, scheme: key.scheme, shared: true };
  }
  delete state.turn.promptId;
  return { version: 'v1', scopeReason: 'steering', shared: false };
}

/**
 * Whether the Deployment names a feature. A lookup that fails is reported and answered no: the prompt is then asked
 * about as every Deployment accepts, and its capture never waits on the feature cache.
 */
function advertised(run: Pick<HookRun, 'credential' | 'mycoHome'>, feature: typeof PROMPT_IDENTITY_FEATURE | typeof PROMPT_SCHEME_FEATURE): boolean {
  try {
    return featureAdvertised(run.credential, run.mycoHome, feature);
  } catch (error) {
    process.stderr.write(`[myco] user-prompt-submit: ${feature} feature unread (${(error as Error).message}); asking without it\n`);
    return false;
  }
}

/** The ask this prompt's text is sent with: a `v1` ask carries the marker, and its prompt's id (and its scheme) or why it names none. */
function promptAsk(naming: PromptNaming, text: string, at: number): ContextAsk {
  const base = { kind: 'prompt' as const, text: text.slice(0, PROMPT_ASK_MAX_CHARS), at };
  if (naming.version === 'legacy') return { ...base, promptId: naming.promptId };
  return naming.shared
    ? { ...base, identity: ASK_IDENTITY_MARKER, promptId: naming.promptId, ...(naming.scheme === undefined ? {} : { promptScheme: naming.scheme }) }
    : { ...base, identity: ASK_IDENTITY_MARKER, scopeReason: naming.scopeReason };
}

/**
 * The `Session::` line, with what the Deployment served the session's previous prompt after a blank line: the helper
 * asks with each prompt's text, and the next prompt renders the answer. Each answer is rendered once, keyed on the
 * instant of the ask it answered: while no newer one arrives (the Deployment unreachable, say), the prompts after it
 * are served the line alone. `rendered` names the ask whose answer this prompt rendered, and the receipt and answer
 * rows and the session record that answer named, recorded with its records.
 */
function withServed(spoolDir: string, sessionId: string, state: SessionState, response: HookResponse): { response: HookResponse; rendered?: { ask: number; receiptId?: string; answerId?: string; sessionRecord?: DeliveredSessionRecord } } {
  const cache = readSessionContext(spoolDir, sessionId);
  const served = cache.prompt;
  if (served === undefined || served.context.length === 0) return { response };
  const ask = promptAnswerKey(cache)!;
  if (state.renderedAsk === ask) return { response };
  return {
    response: { ...response, additionalContext: `${response.additionalContext}\n\n${served.context}` },
    rendered: { ask, receiptId: served.receiptId, answerId: served.answerId, sessionRecord: served.sessionRecord },
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

    const transcriptWritesRows = transcriptWritesTurnRows(agent);
    const v1 = advertised(run, PROMPT_IDENTITY_FEATURE);
    const features: AskFeatures = { v1, schemes: v1 && advertised(run, PROMPT_SCHEME_FEATURE) };
    const named = namePrompt(HOOK_CONFIG[agent]?.promptIdentity, sessionId, input.promptKey, features, transcriptWritesRows);
    const hash = sha256Text(text);
    const human = decision.origin === undefined || decision.origin === 'human';
    // The prompt id the turn-start event names: this submission's own, once it is named.
    let turnPromptId: string | undefined;

    /** Everything this submission captures once it is named, read from and recorded into the session's state. */
    const capture = (naming: PromptNaming, state: SessionState): Required<Pick<HookOutcome, 'events' | 'record' | 'response' | 'ask'>> => {
      const promptId = naming.promptId;
      turnPromptId = promptId;
      // A pasted plan's key is anchored to this prompt's id, or to one minted for the key alone where the prompt has none.
      const planAnchor = promptId ?? mintId();
      // A symbiont whose transcript carries this turn writes no row here and
      // keeps no receipt: the id travels back on the response, a runtime that
      // writes its own transcript stamps it on the turn's lines, and the server's
      // parse is the only writer. Shipping as well would mint a second event for
      // the same row — the ids never meet on the raw insert, so only the
      // projection key hides the duplicate. What this hook does for such a
      // symbiont is inject.
      const events: OutboundEvent[] = transcriptWritesRows || promptId === undefined
        ? []
        : [promptEvent(ctx, { promptId, text, origin: decision.origin, parentPromptId, threadId, threadLabel: thread?.threadLabel ?? undefined })];
      // A plan a person pasted inside a tag envelope is captured with the prompt,
      // whichever side writes the turn: the Deployment's parse scans assistant
      // text for plans and a pasted one is the person's. It keys on the prompt
      // where the transcript writes the turn, and on the session's own tag count
      // where the hooks do, so it never takes a key the parse also derives. Text
      // a runtime injected around a person's prompt is never scanned: a system
      // reminder that quotes a plan is not a plan.
      const plans: Array<[string, string]> = [];
      if (human) {
        let position = state.planTagCount;
        for (const tag of HOOK_CONFIG[agent]?.planTags ?? []) {
          const regex = planTagEnvelopeRegex(tag);
          let match: RegExpExecArray | null;
          while ((match = regex.exec(text)) !== null) {
            const planContent = match[1].trim();
            if (!planContent) continue;
            const planHash = sha256Text(planContent);
            if (state.planHashes[planHash] || plans.some(([h]) => h === planHash)) continue;
            const planKey = transcriptWritesRows ? planKeyForPromptTag(sessionId, tag, planAnchor) : planKeyForTag(sessionId, tag, position);
            position += 1;
            plans.push([planHash, planKey]);
            events.push(planEvent(ctx, { planKey, content: planContent, title: firstHeading(planContent), status: 'active', originPath: `transcript:${tag}`, tags: [tag], promptId: naming.shared ? promptId : undefined }));
          }
        }
      }
      const served = withServed(spool.dir, sessionId, state, { ...response, ...(promptId === undefined ? {} : { promptId }) });
      // The rows the rendered answer named, reported where they reached the agent, in the append that records the render.
      const delivered = served.rendered;
      if (naming.version === 'v1' && delivered !== undefined
        && (delivered.receiptId !== undefined || delivered.answerId !== undefined || delivered.sessionRecord !== undefined)) {
        events.push(contextDeliveredEvent(ctx, {
          receiptId: delivered.receiptId, answerId: delivered.answerId, sessionRecord: delivered.sessionRecord,
          ...(naming.shared ? { renderedIn: naming.promptId, ...(naming.scheme === undefined ? {} : { renderedScheme: naming.scheme }) }
            : { renderedScopeReason: naming.scopeReason }),
        }));
      }
      return {
        events,
        // The receipt lands with the event: recorded first, a crash in between
        // would leave the transcript pass skipping this prompt by hash forever.
        // A transcript-first symbiont keeps only the plan receipts: its prompt
        // row is the parse's.
        record: (next) => {
          if (!transcriptWritesRows && promptId !== undefined) {
            next.promptId = promptId;
            next.prompts[hash] = promptId;
            next.planTagCount += plans.length;
          }
          for (const [planHash, planKey] of plans) next.planHashes[planHash] = planKey;
          if (delivered !== undefined) next.renderedAsk = delivered.ask;
        },
        response: served.response,
        // The helper asks the Deployment with this prompt's text; its answer is the next prompt's context.
        ask: promptAsk(naming, text, run.now()),
      };
    };
    const optional = (): OptionalHookCapture => ({
      events: featureAdvertised(run.credential, run.mycoHome, 'turn')
        ? [turnEvent(ctx, { phase: 'start', promptId: turnPromptId })]
        : [],
    });

    // A key that names a turn is claimed under the session's lock: whether this submission opens its turn depends on
    // what the session's earlier prompt hooks recorded.
    if ('turn' in named) {
      return {
        events: [],
        claim: (state) => {
          const captured = capture(claimTurn(state, named, human), state);
          captured.record(state);
          return { events: captured.events, ask: captured.ask, response: captured.response };
        },
        response: { ...response },
        optional,
      };
    }
    return { ...capture(named, readSessionState(spool.dir, sessionId)), optional };
  });
}
