import { expect } from 'bun:test';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { ageRows, expectPersisted, type ParityTarget } from '../harness.ts';
import { revisionHeaders } from '../settings-revision.ts';
import { event, owner, putCapability, putSetting, untilPublished, type RouteTarget } from './requests.ts';
import { wordVectorProvider } from '../embedding/word-vectors.ts';
import { withSettings } from './settings.ts';
import { saveSpore, writeDueCards } from './knowledge.ts';

export async function blob(target: RouteTarget, bytes: Uint8Array<ArrayBuffer>, mediaType = 'text/plain'): Promise<string> {
  const key = await sha256HexOf(bytes);
  await expectPersisted(await fetch(`${target.url}/blobs/${key}`, { method: 'POST', headers: target.memberHeaders({ 'content-type': mediaType, 'content-length': String(bytes.byteLength) }), body: bytes }), 'blob');
  return key;
}
export async function transcript(target: RouteTarget, sessionId: string, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  await event(target, sessionId, 'transcript.segment', { transcriptId: `tx_${crypto.randomUUID().replaceAll('-', '')}`, baseOffset: 0, length: bytes.byteLength, blob: await blob(target, bytes), agent: 'cursor' }, Date.now(), target.projectId, { producer: { adapter: 'cursor', version: '2026.09' } });
}
export const turns = (target: RouteTarget, sessionId: string) => owner(target, `/api/projects/${target.projectId}/sessions/${encodeURIComponent(sessionId)}/turns`);
export const turn = (target: RouteTarget, sessionId: string, promptId: string) => owner(target, `/api/projects/${target.projectId}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(promptId)}`);
export const publishedTurns = (target: RouteTarget, sessionId: string, ready: (rows: any[]) => boolean) => untilPublished(target, () => turns(target, sessionId), value => value.status === 200 && ready(value.body.rows));
export async function context(target: RouteTarget, path: 'prompt' | 'session', input: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${target.url}/context/${path}`, { method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(input) });
  expect(response.status).toBe(200); const answer = await response.json() as any; expect(answer.persisted).toBe(true); return answer;
}
export const promptContext = (target: RouteTarget, sessionId: string, promptId: string, text: string) => context(target, 'prompt', { sessionId, promptId, text, identity: 1, at: Date.now() });
export async function deliver(target: RouteTarget, sessionId: string, answer: { receiptId?: string; answerId?: string }, rendered: { renderedIn: string } | { renderedScopeReason: 'absent_key' }): Promise<void> {
  await event(target, sessionId, 'context.delivered', { ...answer, ...rendered });
}
export async function withRecallSettings(target: RouteTarget, body: () => Promise<void>, overrides: Record<string, unknown> = {}): Promise<void> {
  const before = await owner(target, `/api/projects/${target.projectId}/capabilities`);
  expect(before.status).toBe(200);
  const settings = { 'cortex.spores.inject_on_prompt_submit': true, 'cortex.plans.inject_intent_nudge_on_prompt_submit': false, 'cortex.instructions.inject_on_session_start': true, 'cortex.instructions.inject_on_subagent_start': true, 'instructions.template': 'Keep captured evidence.', ...overrides };
  try {
    expect((await putCapability(target, 'cortex', true)).status).toBe(200);
    await withSettings(target, settings, body);
  } finally {
    expect((await putCapability(target, 'cortex', before.body.capabilities.cortex)).status).toBe(200);
  }
}

export async function learningSettings(target: RouteTarget): Promise<void> {
  expect((await putCapability(target, 'vault_evolution', true)).status).toBe(200);
  for (const [leaf, value] of Object.entries({ 'agent.harnesses.claude-code.credential': 'worker-login', 'agent.scheduled_tasks_enabled': true, 'agent.tasks': { 'title-summary': { schedule: { maxRunsPerDay: 0 } } }, 'agent.budget.daily_usd': 10 })) expect((await putSetting(target, leaf, value)).status).toBe(200);
}
export async function cardSession(target: ParityTarget, sessionId: string, text: string): Promise<void> {
  await ageRows(target, { table: 'turn_cards', column: 'due_at', byMs: 3_600_000, match: { project_id: target.projectId, session_id: sessionId } });
  expect((await owner(target, `/api/work/now?project=${target.projectId}`)).status).toBe(200);
  await writeDueCards(target, text);
}
export async function withRecall(target: ParityTarget, body: () => Promise<void>): Promise<void> {
  const provider = target.name === 'selfhosted' ? wordVectorProvider() : null;
  try {
    await withRecallSettings(target, async () => {
      expect((await owner(target, '/api/embedding', { method: 'PUT', headers: await revisionHeaders(target, '/api/embedding'), body: JSON.stringify(provider === null ? { provider: 'workers-ai', model: '@cf/baai/bge-m3' } : { provider: 'ollama', model: 'parity-words', endpoint: provider.origin }) })).status).toBe(200);
      for (const text of ['astronomy telescope galaxy', 'sourdough fermentation flour', 'gardening soil seedlings', 'sailing tide compass', 'knitting wool pattern', 'painting canvas pigment', 'piano concert melody', 'cycling mountain trail']) await saveSpore(target, text);
      await body();
    });
  } finally { provider?.stop(); }
}
