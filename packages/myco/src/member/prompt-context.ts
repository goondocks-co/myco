import fs from 'node:fs';
import path from 'node:path';
import { terminalText } from '../utils/terminal-text.js';
import { contextDeliveredEvent, type OutboundEvent } from './envelope.js';
import { canStartRequest, subRequestBudget, type HookBudget } from './budget.js';
import { type ContextAskRequest } from './context-cache.js';
import type { HookRun, HookClaim } from './capture.js';
import type { HookResponse } from '../hooks/response.js';
import { readSessionState, updateSessionState, sessionStatePath, type SessionState } from './session-state.js';
import { ServerClient, withinRequestDeadline } from './transport.js';
import { requestPromptContext, promptRequestsBackedOff, type PromptAnswer } from './prompt-request.js';
import { watchingFeatures } from './prefetch.js';
import { promptContextLogPrefix } from './context-diagnostics.js';
import { HOOK_CONFIG } from '../hooks/hook-config.generated.js';

/** Maximum inline wait when a tool hook can deliver the answer later in the turn. */
export const PROMPT_CONTEXT_TOOL_CAP_MS = 800;
/** Maximum inline wait when this harness has no tool-context delivery path. */
export const PROMPT_CONTEXT_INLINE_CAP_MS = 1_500;
type PromptAsk = Extract<ContextAskRequest, { kind: 'prompt' }>;
export interface PromptRecall {
  current: string;
  asks: Record<string, {
    request: PromptAsk; stage: 'pending' | 'ready' | 'delivered' | 'discarded';
    answer?: PromptAnswer; waitedMs?: number; late: boolean; promptKey?: string;
  }>;
}

/** Queue one ask and retire every earlier submission under the capture append's lock. */
export function queuePromptRecall(state: SessionState, request: PromptAsk, options: { late: boolean; promptKey?: string }): string {
  const recall = state.promptRecall ??= { current: '', asks: {} };
  for (const held of Object.values(recall.asks)) if (held.stage !== 'delivered') held.stage = 'discarded';
  const id = crypto.randomUUID();
  recall.current = id;
  recall.asks[id] = { request, stage: 'pending', ...options };
  return id;
}

const promptContextCapMs = (held: Pick<PromptRecall['asks'][string], 'late'>): number =>
  held.late ? PROMPT_CONTEXT_TOOL_CAP_MS : PROMPT_CONTEXT_INLINE_CAP_MS;

function log(run: Pick<HookRun, 'spool' | 'credential' | 'sessionId'>, id: string, held: PromptRecall['asks'][string], delivery: string): void {
  process.stderr.write(`${promptContextLogPrefix(run.credential.serverUrl, run.spool.projectId)}session ${terminalText(run.sessionId)} ask ${id} prompt ${terminalText(held.request.promptId ?? held.request.scopeReason ?? 'unnamed')} wait_ms=${held.waitedMs ?? 0} cap_ms=${promptContextCapMs(held)} delivery=${delivery}\n`);
}

/** The helper publishes only into the ask that made the request, even after a newer prompt replaces it. */
export function completePromptRecall(spool: HookRun['spool'], sessionId: string, id: string, answer: PromptAnswer | undefined, now: number): void {
  updateSessionState(spool.dir, sessionId, state => {
    const recall = state.promptRecall;
    const held = recall?.asks[id];
    if (held === undefined || held.stage === 'delivered') return;
    held.answer = answer;
    held.stage = held.stage === 'discarded' || recall?.current !== id || answer === undefined ? 'discarded' : 'ready';
  }, now);
}

/** Wait for an atomic state publication using filesystem notifications, with no polling. */
async function waitForAnswer(run: HookRun, id: string, capMs: number): Promise<void> {
  const ready = () => readSessionState(run.spool.dir, run.sessionId).promptRecall?.asks[id]?.stage !== 'pending';
  if (ready() || !run.spool.shouldDial(run.now()) || promptRequestsBackedOff(run.spool, run.now())) return;
  let wake: (() => void) | undefined;
  const changed = new Promise<void>(resolve => { wake = resolve; });
  const file = path.basename(sessionStatePath(run.spool.dir, run.sessionId));
  const watcher = fs.watch(run.spool.dir, (_event, name) => { if (String(name) === file && ready()) wake?.(); });
  try {
    if (!ready()) await withinRequestDeadline(subRequestBudget(run.budget, capMs, run.now()), async ({ signal }) => {
      let abort: () => void = () => {};
      const expired = new Promise<void>(resolve => { abort = resolve; if (signal.aborted) resolve(); else signal.addEventListener('abort', abort, { once: true }); });
      try { await Promise.race([changed, expired]); }
      finally { signal.removeEventListener('abort', abort); }
    });
  } finally { watcher.close(); }
}

/** Resolve this prompt's immediate response; late-capable asks remain available to a local tool hook. */
export async function promptContext(run: HookRun, id: string, response: HookResponse): Promise<{ events: OutboundEvent[]; claim: (state: SessionState) => HookClaim }> {
  const started = Date.now();
  const original = readSessionState(run.spool.dir, run.sessionId).promptRecall?.asks[id];
  if (original === undefined) return { events: [], claim: () => ({ events: [] }) };
  const capMs = promptContextCapMs(original);
  if (run.credentialSource === 'env') {
    const held = readSessionState(run.spool.dir, run.sessionId).promptRecall?.asks[id];
    if (held !== undefined) {
      const client = new ServerClient(run.credential, watchingFeatures(run.fetch ?? globalThis.fetch, {
        serverUrl: run.credential.serverUrl, spoolDir: run.spool.dir, mycoHome: run.mycoHome, now: run.now,
      }), { credentialSource: 'env' });
      const answer = await requestPromptContext({ ...run, client, capMs }, held.request);
      completePromptRecall(run.spool, run.sessionId, id, answer, run.now());
    }
  } else await waitForAnswer(run, id, capMs);
  const waitedMs = Date.now() - started;
  return { events: [], claim: state => {
    const held = state.promptRecall?.asks[id];
    if (held === undefined) {
      log(run, id, { ...original, waitedMs }, 'discarded');
      return { events: [] };
    }
    held.waitedMs = waitedMs;
    if (held.stage === 'pending' && held.late && run.credentialSource === 'registry') {
      log(run, id, held, 'pending');
      return { events: [] };
    }
    if (held.stage === 'pending') held.stage = 'discarded';
    return consumePromptRecall(run, state, { id, response, delivery: 'inline' });
  } };
}

/** Claim a render under the append lock; the delivery event and the consumed mark commit together. */
function consumePromptRecall(run: HookRun, state: SessionState, options: { id: string; response: HookResponse; delivery: 'inline' | 'tool' }): HookClaim {
  const recall = state.promptRecall;
  const held = recall?.asks[options.id];
  if (held === undefined) return { events: [] };
  if (held.stage === 'ready' && recall?.current === options.id && held.answer !== undefined) {
    held.stage = 'delivered';
    const answer = held.answer;
    const ask = held.request;
    const events = ask.identity !== undefined && answer.context.length > 0
      && (answer.receiptId !== undefined || answer.answerId !== undefined || answer.sessionRecord !== undefined)
      ? [contextDeliveredEvent(run.ctx, { receiptId: answer.receiptId, answerId: answer.answerId, sessionRecord: answer.sessionRecord,
        ...(ask.promptId !== undefined ? { renderedIn: ask.promptId, renderedScheme: ask.promptScheme } : { renderedScopeReason: ask.scopeReason }) })] : [];
    log(run, options.id, held, options.delivery);
    return { events, response: answer.context.length === 0 ? options.response : { ...options.response,
      additionalContext: [options.response.additionalContext, answer.context].filter(Boolean).join('\n\n') } };
  }
  if (held.stage === 'discarded') log(run, options.id, held, 'discarded');
  return { events: [] };
}

/** A tool hook reads only this session's current held answer and never waits for it. */
export function toolPromptContext(run: HookRun, state: SessionState, response: HookResponse = {}): HookClaim {
  const recall = state.promptRecall;
  const held = recall?.asks[recall.current];
  if (recall === undefined || held === undefined || !held.late || held.stage !== 'ready') return { events: [], response };
  if (held.promptKey !== undefined && run.input.promptKey !== held.promptKey) return { events: [], response };
  if (HOOK_CONFIG[run.agent]?.capabilities.postToolUseInjection !== true) return { events: [], response };
  return consumePromptRecall(run, state, { id: recall.current, response, delivery: 'tool' });
}

/** Helper-owned requests finish after the prompt wait and release answers the member has discarded. */
export async function fetchPromptRecalls(opts: {
  spool: HookRun['spool']; client: ServerClient; mycoHome: string; budget: HookBudget; now: () => number; capMs: number;
}): Promise<boolean> {
  opts.spool.assertClientDestination(opts.client);
  for (const sessionId of opts.spool.stateSessionIds()) {
    const recall = readSessionState(opts.spool.dir, sessionId).promptRecall;
    for (const [id, held] of Object.entries(recall?.asks ?? {})) {
      if (!canStartRequest(opts.budget, opts.now())) return true;
      if (held.stage === 'pending') {
        const answer = await requestPromptContext({ ...opts, sessionId }, held.request);
        completePromptRecall(opts.spool, sessionId, id, answer, opts.now());
      }
      const live = readSessionState(opts.spool.dir, sessionId).promptRecall?.asks[id];
      if (live?.stage === 'discarded') {
        const receiptId = live.answer?.receiptId;
        if (receiptId !== undefined) {
          const outcome = await opts.client.postPersisted('/context/discard', { sessionId, receiptId }, subRequestBudget(opts.budget, opts.capMs, opts.now()));
          if (outcome.class !== 'acked' && outcome.class !== 'route_missing') continue;
        }
        process.stderr.write(`${promptContextLogPrefix(opts.client.serverUrl, opts.spool.projectId)}session ${terminalText(sessionId)} ask ${id} wait_ms=${live.waitedMs ?? 0} cap_ms=${promptContextCapMs(live)} delivery=discarded\n`);
        updateSessionState(opts.spool.dir, sessionId, state => { if (state.promptRecall?.asks[id]?.stage === 'discarded') delete state.promptRecall.asks[id]; }, opts.now());
      } else if (live?.stage === 'delivered') {
        updateSessionState(opts.spool.dir, sessionId, state => { if (state.promptRecall?.asks[id]?.stage === 'delivered') delete state.promptRecall.asks[id]; }, opts.now());
      }
    }
  }
  return false;
}
