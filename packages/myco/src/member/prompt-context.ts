import path from 'node:path';
import { isDeliveredSessionRecord, type DeliveredSessionRecord } from '@goondocks/myco-shared/prompt-identity';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';
import { terminalText } from '@myco/utils/terminal-text.js';
import { subRequestBudget } from './budget.js';
import type { HookRun } from './capture.js';
import { contextDir, type ContextAskRequest } from './context-cache.js';
import { OFFLINE_BACKOFF_INITIAL_MS, OFFLINE_BACKOFF_MAX_MS } from './constants.js';
import { promptContextLogPrefix } from './context-diagnostics.js';
import { watchingFeatures } from './prefetch.js';
import { ensureMemberDir, ensurePrivateFile, readPrivateJson, writePrivateFileAtomic } from './store.js';
import { classifyEventAnswer, ServerClient, type Outcome } from './transport.js';

/** Prompt recall's maximum wait, including response headers and body. */
export const PROMPT_CONTEXT_CAP_MS = 1_500;
interface Retry { id: string; at: number; backoff: number }
interface PromptAnswer { context: string; receiptId?: string; answerId?: string; sessionRecord?: DeliveredSessionRecord }
const rowId = (id: unknown): string | undefined => typeof id === 'string' && id.length > 0 ? id : undefined;

/** Same-prompt recall, admitted after capture; misses back off independently of capture delivery. */
export async function promptContext(run: HookRun, ask: Extract<ContextAskRequest, { kind: 'prompt' }>): Promise<PromptAnswer | undefined> {
  const { spool, mycoHome, credential, now } = run;
  if (run.pending || !spool.shouldDial(now()) || run.budget.deadline <= now()) return undefined;
  const budget = subRequestBudget(run.budget, PROMPT_CONTEXT_CAP_MS, now());
  const file = path.join(contextDir(spool.dir), 'prompt-retry.json');
  ensureMemberDir(path.dirname(file), mycoHome);
  const lock = `${file}.lock`;
  ensurePrivateFile(lock);
  const change = <T>(fn: (prior: Retry | undefined) => T): T => withFileLockSync(lock, () => {
    const read = readPrivateJson<Retry>(file);
    if (!read.ok && read.reason !== 'missing') throw new Error(`Prompt recall backoff unreadable: ${read.reason}`);
    if (read.ok && (read.value === null || typeof read.value !== 'object' || typeof read.value.id !== 'string'
      || !Number.isFinite(read.value.at) || !Number.isFinite(read.value.backoff) || read.value.backoff < 0)) {
      throw new Error('Prompt recall backoff is malformed');
    }
    return fn(read.ok ? read.value : undefined);
  });
  const id = crypto.randomUUID();
  const admitted = change((prior) => {
    if (prior !== undefined && prior.at > now()) return false;
    writePrivateFileAtomic(file, JSON.stringify({ id, at: now() + budget.requestTimeoutMs, backoff: prior?.backoff ?? 0 }));
    return true;
  });
  if (!admitted) return undefined;
  const started = Date.now();
  let outcome: Outcome | undefined;
  try {
    const client = new ServerClient(credential, watchingFeatures(run.fetch ?? globalThis.fetch, {
      serverUrl: credential.serverUrl, spoolDir: spool.dir, mycoHome, now,
    }), { credentialSource: credential.source });
    spool.assertClientDestination(client);
    outcome = classifyEventAnswer(await client.request('POST', '/context/prompt', {
        body: JSON.stringify({ sessionId: run.sessionId, promptId: ask.promptId, promptScheme: ask.promptScheme, scopeReason: ask.scopeReason,
          identity: ask.identity, at: ask.at, text: ask.text, agent: ask.agent }), headers: { 'content-type': 'application/json' },
        budget,
      }));
    if (outcome?.class !== 'acked') return undefined;
    const body = outcome.body;
    const skipped = Array.isArray(body.skipped) ? body.skipped.map(String).map(terminalText).join(', ') : '';
    process.stderr.write(`${promptContextLogPrefix(credential.serverUrl, spool.projectId)}answered ${typeof body.context === 'string' && body.context.length > 0 ? 'with context' : 'empty'}; skipped: ${skipped || 'none'}\n`);
    return { context: typeof body.context === 'string' ? body.context : '', receiptId: rowId(body.receiptId), answerId: rowId(body.answerId),
      ...(isDeliveredSessionRecord(body.sessionRecord) ? { sessionRecord: body.sessionRecord } : {}) };
  } finally {
    change((prior) => {
      if (prior?.id !== id) return;
      const backoff = outcome?.class === 'acked' ? 0 : Math.min(Math.max(OFFLINE_BACKOFF_INITIAL_MS, prior.backoff * 2), OFFLINE_BACKOFF_MAX_MS);
      writePrivateFileAtomic(file, JSON.stringify({ id, at: now() + backoff, backoff }));
    });
    process.stderr.write(`${promptContextLogPrefix(credential.serverUrl, spool.projectId)}session ${terminalText(run.sessionId)} prompt ${terminalText(ask.promptId ?? ask.scopeReason ?? 'unnamed')} wait_ms=${Date.now() - started} result=${outcome?.class ?? 'timeout'}\n`);
  }
}
