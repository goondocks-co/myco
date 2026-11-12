import { expect } from 'bun:test';
import { RUN_AUDIT } from '../../helpers/run-audit.ts';
import { claimRun, endRun, mcp, owner, runTool, type ClaimedRun, type RouteTarget } from './requests.ts';

export async function saveSpore(target: RouteTarget, content: string, projectId = target.projectId, type = 'gotcha'): Promise<{ id: string }> {
  const saved = await mcp(target, 'myco_spores', { op: 'save', type, content, agent_line: 'When this comes up, keep the note.', project: projectId }, projectId);
  expect(typeof saved.id).toBe('string'); return { id: String(saved.id) };
}
export async function planStatusCounts(target: RouteTarget): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const listed: { status: number; body: { plans: Array<{ status: string }>; cursor: string | null } } = await owner(target, `/api/projects/${target.projectId}/plans?limit=50${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
    expect(listed.status).toBe(200); for (const plan of listed.body.plans) counts[plan.status] = (counts[plan.status] ?? 0) + 1;
    if ((cursor = listed.body.cursor ?? null) === null) return counts;
  }
  throw new Error('the plan list did not end');
}
const cardOf = (text: string) => ({ asked: text, done: text, outcome: 'done', decisions: [], rejected: [], errors: [], corrections: [], files: [], commands: [], open_questions: [] });

async function take(target: RouteTarget, task: string): Promise<ClaimedRun> {
  const claimed = await claimRun(target);
  expect({ claimed: claimed.claimed, task: claimed.run?.task, reason: claimed.reason }).toMatchObject({ claimed: true, task }); return claimed.run as ClaimedRun;
}
// The caller ages turn_cards.due_at first, so this claim finds the due card run and writes one card per assigned turn.
export async function writeDueCards(target: RouteTarget, text: string): Promise<void> {
  const run = await take(target, 'turn-cards');
  const keys: string[] = [];
  let revision = '';
  for (let page = 1; page < 20; page += 1) {
    const material = await runTool<{ revision: string; turns?: Array<{ turn_key: string }>; next_page?: number }>(target, run, 'myco_run_cards', { op: 'material', page, ...(page === 1 ? {} : { revision }) });
    revision = material.revision;
    for (const turn of material.turns ?? []) keys.push(turn.turn_key);
    if (material.next_page === undefined) break;
  }
  expect(keys.length).toBeGreaterThan(0);
  const written = await runTool<{ written: number }>(target, run, 'myco_run_cards', { op: 'write', revision, cards: keys.map((turn) => ({ turns: [turn], signal: 'high', card: cardOf(text) })) });
  expect(written.written).toBe(keys.length);
  await runTool(target, run, 'myco_run', { op: 'report', action: 'carded', summary: 'Carded the turn.', audit: RUN_AUDIT }); expect(await endRun(target, run, 0.25)).toMatchObject({ ended: true });
}
// The owner's title ask, taken by a worker, which writes the title the caller names.
export async function writeSessionTitle(target: RouteTarget, sessionId: string, title: string, summary: string): Promise<void> {
  const asked = await owner(target, `/api/projects/${target.projectId}/sessions/${encodeURIComponent(sessionId)}/title`, { method: 'POST' });
  expect({ status: asked.status, outcome: asked.body.outcome }).toEqual({ status: 200, outcome: expect.stringMatching(/^(queued|dispatched)$/) });
  const run = await take(target, 'title-summary');
  expect(await runTool(target, run, 'myco_run_sessions', { op: 'title', title, summary })).toMatchObject({ written: true });
  await runTool(target, run, 'myco_run', { op: 'report', action: 'summary', summary, audit: RUN_AUDIT }); expect(await endRun(target, run, 0.1)).toMatchObject({ ended: true });
}
