import path from 'node:path';
import { isDeliveredSessionRecord, type DeliveredSessionRecord } from '@goondocks/myco-shared/prompt-identity';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';
import { terminalText } from '@myco/utils/terminal-text.js';
import { subRequestBudget, type HookBudget } from './budget.js';
import { contextDir, type ContextAskRequest } from './context-cache.js';
import { OFFLINE_BACKOFF_INITIAL_MS, OFFLINE_BACKOFF_MAX_MS } from './constants.js';
import { promptContextLogPrefix } from './context-diagnostics.js';
import { ensureMemberDir, ensurePrivateFile, readPrivateJson, writePrivateFileAtomic } from './store.js';
import { classifyEventAnswer, ServerClient, type Outcome } from './transport.js';
import type { MemberSpool } from './spool.js';

export interface PromptRequestRun {
  spool: MemberSpool; mycoHome: string; client: ServerClient;
  now: () => number; budget: HookBudget; capMs: number; sessionId: string;
}
interface Retry { id: string; at: number; backoff: number }
export interface PromptAnswer { context: string; receiptId?: string; answerId?: string; sessionRecord?: DeliveredSessionRecord }
const rowId = (id: unknown): string | undefined => typeof id === 'string' && id.length > 0 ? id : undefined;

const retryPath = (spool: MemberSpool) => path.join(contextDir(spool.dir), 'prompt-retry.json');
function readRetry(file: string): Retry | undefined {
  const read = readPrivateJson<Retry>(file);
  if (!read.ok && read.reason !== 'missing') throw new Error(`Prompt recall backoff unreadable: ${read.reason}`);
  if (read.ok && (read.value === null || typeof read.value !== 'object' || typeof read.value.id !== 'string'
    || !Number.isFinite(read.value.at) || !Number.isFinite(read.value.backoff) || read.value.backoff < 0)) {
    throw new Error('Prompt recall backoff is malformed');
  }
  return read.ok ? read.value : undefined;
}

/** A prior miss suppresses another prompt wait while recall is backing off. */
export function promptRequestsBackedOff(spool: MemberSpool, now: number): boolean {
  const retry = readRetry(retryPath(spool));
  return retry !== undefined && retry.backoff > 0 && retry.at > now;
}

/** Same-prompt recall, admitted after capture; misses back off independently of capture delivery. */
export async function requestPromptContext(run: PromptRequestRun, ask: Extract<ContextAskRequest, { kind: 'prompt' }>): Promise<PromptAnswer | undefined> {
  const { spool, mycoHome, client, now } = run;
  const serverUrl = client.serverUrl;
  if (!spool.shouldDial(now()) || run.budget.deadline <= now()) return undefined;
  const budget = subRequestBudget(run.budget, run.capMs, now());
  const file = retryPath(spool);
  ensureMemberDir(path.dirname(file), mycoHome);
  const lock = `${file}.lock`;
  ensurePrivateFile(lock);
  const change = <T>(fn: (prior: Retry | undefined) => T): T => withFileLockSync(lock, () => fn(readRetry(file)));
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
    spool.assertClientDestination(client);
    outcome = classifyEventAnswer(await client.request('POST', '/context/prompt', {
        body: JSON.stringify({ sessionId: run.sessionId, promptId: ask.promptId, promptScheme: ask.promptScheme, scopeReason: ask.scopeReason,
          identity: ask.identity, at: ask.at, text: ask.text, agent: ask.agent }), headers: { 'content-type': 'application/json' },
        budget,
      }));
    if (outcome?.class !== 'acked') return undefined;
    const body = outcome.body;
    const skipped = Array.isArray(body.skipped) ? body.skipped.map(String).map(terminalText).join(', ') : '';
    process.stderr.write(`${promptContextLogPrefix(serverUrl, spool.projectId)}answered ${typeof body.context === 'string' && body.context.length > 0 ? 'with context' : 'empty'}; skipped: ${skipped || 'none'}\n`);
    return { context: typeof body.context === 'string' ? body.context : '', receiptId: rowId(body.receiptId), answerId: rowId(body.answerId),
      ...(isDeliveredSessionRecord(body.sessionRecord) ? { sessionRecord: body.sessionRecord } : {}) };
  } finally {
    change((prior) => {
      if (prior?.id !== id) return;
      const backoff = outcome?.class === 'acked' ? 0 : Math.min(Math.max(OFFLINE_BACKOFF_INITIAL_MS, prior.backoff * 2), OFFLINE_BACKOFF_MAX_MS);
      writePrivateFileAtomic(file, JSON.stringify({ id, at: now() + backoff, backoff }));
    });
    process.stderr.write(`${promptContextLogPrefix(serverUrl, spool.projectId)}request_ms=${Date.now() - started} result=${outcome?.class ?? 'timeout'}\n`);
  }
}
