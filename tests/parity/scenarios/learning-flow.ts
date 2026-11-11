import { expect } from 'bun:test';
import { ageRows, documentsPublished, lit, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';
import { offeredHarness } from '../../myco-server/helpers/offered-harness.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { CARD_REPORT_ACTION, EXTRACTION_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { RUN_AUDIT } from '../../helpers/run-audit.ts';
import { revisionHeaders } from '../settings-revision.ts';

type LearningTarget = Pick<ParityTarget, 'url' | 'projectId' | 'memberHeaders' | 'ownerHeaders' | 'sql'>;
type Claim = { claimed: boolean; reason?: string; run: { id: string; task: string; attemptId: string; runToken: string } };
interface CardMaterial { revision: string; turns: { input: string }[] }
interface LearningMaterial { cards: { card: string }[] }
const EXACT_ERROR = "Error: capture lease refused for spool generation 17 (owner mismatch)";

/** One learning outcome through capture, publication, claims, run tools and settlement. */
export async function runLearningFlow(target: LearningTarget, request: (request: Request) => Promise<Response> = fetch) {
  const now = Date.now(), at = now - 3_600_000, session = 'learning-flow', prompt = crypto.randomUUID();
  const owner = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
  const post = async <T = unknown>(path: string, body: unknown, headers = target.memberHeaders()): Promise<T> => {
    const response = await request(new Request(`${target.url}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    expect(response.status, path).toBe(200);
    return response.json() as Promise<T>;
  };
  for (const [leaf, value] of [
    ['agent.harnesses.claude-code.credential', 'worker-login'], ['agent.scheduled_tasks_enabled', true],
    ['agent.tasks', { 'title-summary': { schedule: { maxRunsPerDay: 0 } } }], ['agent.budget.daily_usd', 1],
  ] as const) {
    const response = await request(new Request(`${target.url}/api/settings/${leaf}`, { method: 'PUT', headers: { ...owner, ...await revisionHeaders({ url: target.url, ownerHeaders: () => target.ownerHeaders() }, `/api/settings/${leaf}`, undefined, request) }, body: JSON.stringify({ value }) }));
    expect({ leaf, status: response.status, body: await response.json() }).toMatchObject({ status: 200 });
  }
  await target.sql("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Myco','built-in',1,1)");
  const capture = async (kind: string, payload: Record<string, unknown>, time = at) => {
    expect(await post('/events', { eventId: crypto.randomUUID(), sessionId: session, kind, createdAt: time,
      channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload })).toMatchObject({ persisted: true });
  };
  await capture('session.start', { agent: 'claude-code', startedAt: at });
  await capture('prompt', { promptId: prompt, text: 'Fix the capture lease refusal and preserve the exact error.', origin: 'user' });
  await capture('tool.failure', { toolCallId: crypto.randomUUID(), promptId: prompt, toolName: 'Bash', input: { command: 'capture --check' }, success: false, errorMessage: EXACT_ERROR });
  await capture('response', { responseId: crypto.randomUUID(), promptId: prompt, text: 'Reopen the spool under its recorded owner before capture.' });
  await capture('session.end', { endedAt: at });
  await documentsPublished(target, session, target.projectId, request);
  const pulledNeeds = async () => {
    const response = await request(new Request(`${target.url}/api/work/now?project=${target.projectId}`, { headers: target.ownerHeaders() }));
    expect(response.status).toBe(200);
    const answer = await response.json() as { needsYou: { key: string; what: string; runId: string | null }[]; unavailable: string[] };
    expect(answer.unavailable).toEqual([]);
    return answer.needsYou.filter(item => item.key.startsWith('pulled:'));
  };
  expect(await pulledNeeds()).toEqual([]);
  await ageRows(target as ParityTarget, { table: 'turn_cards', column: 'due_at', byMs: 3_600_000, match: { project_id: target.projectId, session_id: session } });
  expect(await pulledNeeds()).toMatchObject([{ what: expect.stringContaining('Summarize session turns has waited'), runId: null }]);
  const claim = () => post<Claim>('/worker/claim', { harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES });
  const call = async <T = unknown>(run: Claim['run'], name: string, input: Record<string, unknown>): Promise<T> => {
    const body = await post<{ error?: unknown; result: { isError?: boolean; structuredContent: { result: T } } }>('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project: target.projectId, ...input } } }, memberHeadersFor(run.runToken, target.projectId));
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).not.toBe(true);
    return body.result.structuredContent.result;
  };
  const settle = async (run: Claim['run'], action: string) => {
    await call(run, 'myco_run', { op: 'report', action, summary: 'Learned the capture fix', audit: RUN_AUDIT });
    expect(await post('/worker/end', { projectId: target.projectId, runId: run.id, attemptId: run.attemptId, status: 'completed',
      usage: { inputTokens: null, outputTokens: null, costUsd: run.task === 'turn-cards' ? 0.25 : 0.75 } })).toMatchObject({ ended: true, status: 'completed' });
  };
  const cards = await claim();
  expect(cards).toMatchObject({ claimed: true, run: { task: 'turn-cards' } });
  const material = await call<CardMaterial>(cards.run, 'myco_run_cards', { op: 'material' });
  expect(material.turns).toHaveLength(1);
  expect(material.turns[0].input).toContain(EXACT_ERROR);
  expect(await call(cards.run, 'myco_run_cards', { op: 'write', revision: material.revision, cards: [{ turns: [prompt], signal: 'high', card: {
    asked: 'Fix capture', done: 'Reopened the spool under its recorded owner', outcome: 'done', decisions: [], rejected: [],
    errors: [{ error: EXACT_ERROR, fix: 'Reopen the spool under its recorded owner.' }], corrections: [], files: [], commands: ['capture --check'], open_questions: [],
  } }] })).toMatchObject({ written: 1 });
  await settle(cards.run, CARD_REPORT_ACTION);
  const learning = await claim();
  expect(learning).toMatchObject({ claimed: true, run: { task: 'extract-curate' } });
  const slice = await call<LearningMaterial>(learning.run, 'myco_run_learning', { op: 'material' });
  expect(slice.cards[0].card).toContain(EXACT_ERROR);
  const saved = await call<{ id: string }>(learning.run, 'myco_spores', { op: 'save', type: 'gotcha', session_id: session,
    agent_line: 'When capture refuses a spool lease, reopen it under its recorded owner.',
    content: `${EXACT_ERROR}. Reopen the spool under its recorded owner before capture.` });
  expect(typeof saved.id).toBe('string');
  expect(await call(learning.run, 'myco_run_learning', { op: 'complete', handoff: '' })).toEqual({ completed: true, covered: 1 });
  await settle(learning.run, EXTRACTION_REPORT_ACTION);
  expect(await target.sql(`SELECT session_id,content FROM spores WHERE project_id=${lit(target.projectId)} AND id=${lit(saved.id)}`))
    .toEqual([{ session_id: session, content: `${EXACT_ERROR}. Reopen the spool under its recorded owner before capture.` }]);
  await capture('prompt', { promptId: crypto.randomUUID(), text: 'Document the capture fix for the next operator.', origin: 'user' }, at + 1000);
  await capture('session.end', { endedAt: at + 1000 }, at + 1000);
  await documentsPublished(target, session, target.projectId, request);
  expect((await target.sql(`SELECT pending_cards FROM learning_sessions WHERE project_id=${lit(target.projectId)} AND session_id=${lit(session)}`))[0]!.pending_cards).toBeGreaterThan(0);
  expect(await claim()).toMatchObject({ claimed: false });
  expect(await target.sql(`SELECT COUNT(*) AS n FROM agent_run_attempts`)).toEqual([{ n: 2 }]);
  const status = await request(new Request(`${target.url}/api/status`, { headers: target.ownerHeaders() }));
  const health = await status.json() as { learning: { line: string } };
  expect(health).toMatchObject({ budget: { dailyUsd: 1, automaticUsd: 1 }, learning: { turnsAwaitingCards: 1 } });
  expect(health.learning.line).toContain('learning resumes when the rolling 24 hour budget has room');
}

export const learningFlow: ParityScenario = {
  name: 'learning: verbatim failure becomes a session-citing spore and daily spend stops the next claim',
  dedicated: { timeoutMs: 180_000 },
  run: target => runLearningFlow(target),
};
