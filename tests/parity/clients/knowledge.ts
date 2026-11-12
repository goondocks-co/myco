import { expect } from 'bun:test';
import { CARD_REPORT_ACTION, TITLING_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { RUN_AUDIT } from '../../helpers/run-audit.ts';
import { claimRun, endRun, mcp, owner, runTool, type Answer, type ClaimedRun, type RouteTarget } from './requests.ts';

/** A spore the member saved. The id is the one the tool minted. */
export async function saveSpore(target: RouteTarget, content: string, projectId = target.projectId, type = 'gotcha'): Promise<{ id: string }> {
  const saved = await mcp(target, 'myco_spores', {
    op: 'save', type, content, agent_line: 'When this comes up, keep the note.', project: projectId,
  }, projectId);
  expect(typeof saved.id).toBe('string');
  return { id: String(saved.id) };
}

/** One plan as a reader opens it. */
export async function planDetail(target: RouteTarget, planKey: string): Promise<Answer> {
  return owner(target, `/api/projects/${target.projectId}/plans/${planKey}`);
}

/** How many plans of each status the Project lists, paging until the list ends. */
export async function planStatusCounts(target: RouteTarget): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const listed: { status: number; body: { plans: Array<{ status: string }>; cursor: string | null } } = await owner(target, `/api/projects/${target.projectId}/plans?limit=50${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
    expect(listed.status).toBe(200);
    for (const plan of listed.body.plans as Array<{ status: string }>) counts[plan.status] = (counts[plan.status] ?? 0) + 1;
    cursor = listed.body.cursor ?? null;
    if (cursor === null) return counts;
  }
  throw new Error('the plan list did not end');
}

const cardOf = (text: string) => ({
  asked: text, done: text, outcome: 'done', decisions: [], rejected: [], errors: [], corrections: [], files: [], commands: [], open_questions: [],
});

/**
 * The turn-card run that is due for this session writes one card per assigned turn.
 * The caller ages `turn_cards.due_at` first, so the claim finds the work.
 */
export async function writeDueCards(target: RouteTarget, text: string): Promise<void> {
  const claimed = await claimRun(target);
  expect({ claimed: claimed.claimed, task: claimed.run?.task, reason: claimed.reason }).toMatchObject({ claimed: true, task: 'turn-cards' });
  const run = claimed.run as ClaimedRun;
  const keys: string[] = [];
  let revision = '';
  for (let page = 1; page < 20; page += 1) {
    const material = await runTool<{ revision: string; turns?: Array<{ turn_key: string }>; next_page?: number }>(
      target, run, 'myco_run_cards', { op: 'material', page, ...(page === 1 ? {} : { revision }) },
    );
    revision = material.revision;
    for (const turn of material.turns ?? []) keys.push(turn.turn_key);
    if (material.next_page === undefined) break;
  }
  expect(keys.length).toBeGreaterThan(0);
  const written = await runTool<{ written: number }>(target, run, 'myco_run_cards', {
    op: 'write', revision, cards: keys.map((turn) => ({ turns: [turn], signal: 'high', card: cardOf(text) })),
  });
  expect(written.written).toBe(keys.length);
  await runTool(target, run, 'myco_run', { op: 'report', action: CARD_REPORT_ACTION, summary: 'Carded the turn.', audit: RUN_AUDIT });
  expect(await endRun(target, run, 0.25)).toMatchObject({ ended: true });
}

/** The owner's ask for a title, taken by a worker, which writes the title the caller names. */
export async function writeSessionTitle(target: RouteTarget, sessionId: string, title: string, summary: string): Promise<void> {
  const asked = await owner(target, `/api/projects/${target.projectId}/sessions/${encodeURIComponent(sessionId)}/title`, { method: 'POST' });
  expect({ status: asked.status, outcome: asked.body.outcome }).toEqual({ status: 200, outcome: expect.stringMatching(/^(queued|already|dispatched)$/) });
  const claimed = await claimRun(target);
  expect({ claimed: claimed.claimed, task: claimed.run?.task, reason: claimed.reason }).toMatchObject({ claimed: true, task: 'title-summary' });
  const run = claimed.run as ClaimedRun;
  expect(await runTool(target, run, 'myco_run_sessions', { op: 'title', title, summary })).toMatchObject({ written: true });
  await runTool(target, run, 'myco_run', { op: 'report', action: TITLING_REPORT_ACTION, summary, audit: RUN_AUDIT });
  expect(await endRun(target, run, 0.1)).toMatchObject({ ended: true });
}
