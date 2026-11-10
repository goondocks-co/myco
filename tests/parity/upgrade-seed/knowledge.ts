import { expect } from 'bun:test';
import { documentsPublished } from '../harness.ts';
import { event, mcp, owner, pick, type RouteTarget, type SeedTarget } from './requests.ts';

const BACKGROUND = ['the lunch menu has tacos and salsa', 'water the garden tomatoes at dawn', 'oil the bicycle chain weekly', 'tune the guitar strings before practice',
  'set the coffee grinder burr finer', 'pack hiking boots for the mountain trail', 'practice piano scales slowly', 'sharpen kitchen knives on the stone'];

/** What members recorded and were served, by the ids the product answered. */
export interface KnowledgeSeed {
  spores: { superseded: string; current: string };
  plans: { saved: string };
  /** The prompt whose context the hook asked for before it was captured. */
  served: { sessionId: string; promptId: string };
}

/**
 * A spore superseded by a broader one, both citing a session, a plan saved over MCP, and the context a prompt hook
 * was served (the answer and the spores it carried) before its prompt was captured.
 */
export async function seedKnowledge(target: SeedTarget, sessionId: string, word: string, stamp: number): Promise<KnowledgeSeed> {
  const first = await mcp(target, 'myco_spores', { op: 'save', type: 'decision', content: `upgrade keeps data ${word}`, agent_line: 'When upgrading a schema, keep every user record readable.', session_id: sessionId, project: target.projectId });
  const second = await mcp(target, 'myco_spores', { op: 'save', type: 'decision', content: `upgrade keeps data and refusals ${word}`, agent_line: 'When upgrading a schema, keep records and refusals unchanged.', session_id: sessionId, project: target.projectId });
  const spores = { superseded: String(first.id), current: String(second.id) };
  expect(await mcp(target, 'myco_spores', { op: 'supersede', old_spore_id: spores.superseded, new_spore_id: spores.current, reason: 'broader', session_id: sessionId, project: target.projectId }))
    .toMatchObject({ status: 'superseded' });
  const saved = await mcp(target, 'myco_plans', { op: 'save', session_id: sessionId, plan_key: `upgrade-saved-${stamp}`, content: '- [ ] read back', project: target.projectId });
  expect(saved.ok).toBe(true);
  // Other things the members noted, against which recall tells the upgrade spores apart.
  for (const note of BACKGROUND) {
    await mcp(target, 'myco_spores', { op: 'save', type: 'discovery', content: note, agent_line: `When it comes up, ${note}.`, session_id: sessionId, project: target.projectId });
  }
  await target.primeEmbedding(target.projectId);
  const found = await owner(target, `/api/projects/${target.projectId}/search?mode=fts&q=${encodeURIComponent(word)}`);
  expect((found.body.hits as Array<{ id: string }>).map((hit) => hit.id)).toContain(spores.current);

  const served = { sessionId, promptId: crypto.randomUUID() };
  const text = 'When upgrading a schema, does the upgrade keep records and refusals unchanged?';
  const context = await fetch(`${target.url}/context/prompt`, {
    method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, promptId: served.promptId, text }),
  });
  expect(context.status).toBe(200);
  expect(await context.json()).toMatchObject({ parts: [{ kind: 'spores' }] });
  await event(target, sessionId, 'prompt', { promptId: served.promptId, text, origin: 'user' }, stamp + 40);
  await documentsPublished(target, sessionId);
  return { spores, plans: { saved: String(saved.id) }, served };
}

/** What members read of the seeded knowledge: each spore and its lineage, the spore and plan lists, and the served context. */
export async function observeKnowledge(target: RouteTarget, seed: KnowledgeSeed, sessionId: string, word: string): Promise<Record<string, unknown>> {
  const project = `/api/projects/${target.projectId}`;
  const sporeFields = ['id', 'status', 'content', 'agent_line', 'session_id', 'superseded_by', 'predecessors'] as const;
  const planFields = ['id', 'title', 'status', 'progress', 'prompt_id'] as const;
  const current = await owner(target, `${project}/spores/${seed.spores.current}`);
  const sporeList = await owner(target, `${project}/spores`);
  const planBoard = await owner(target, `/api/plans?project=${target.projectId}`);
  const listed = (await mcp(target, 'myco_plans', { op: 'list', session: sessionId, status: 'all' }) as unknown as { plans: unknown[] }).plans;
  const turn = await owner(target, `${project}/sessions/${seed.served.sessionId}/turns/${seed.served.promptId}`);
  // Full-text search, which reads the store the upgrade carries; the vector index lives outside it.
  const search = await owner(target, `${project}/search?mode=fts&q=${encodeURIComponent(word)}`);
  return {
    superseded: pick(await mcp(target, 'myco_spores', { op: 'get', id: seed.spores.superseded }), sporeFields),
    current: [current.status, pick(current.body.spore, ['id', 'status', 'content', 'agentLine']), current.body.supersededBy, current.body.supersedes],
    sporeList: [sporeList.status, (sporeList.body.spores ?? []).map((spore: unknown) => pick(spore, ['id', 'status', 'content', 'agentLine', 'sessionId']))],
    planBoard: [planBoard.status, (planBoard.body.plans ?? []).map((plan: unknown) => pick(plan, ['planKey', 'sessionId', 'title', 'status', 'content', 'progress'])), planBoard.body.totals],
    search: [search.status, (search.body.hits ?? []).map((hit: unknown) => pick(hit, ['id', 'type', 'kind', 'title']))],
    plans: listed.map((plan) => pick(plan, planFields)),
    saved: pick(await mcp(target, 'myco_plans', { op: 'get', id: seed.plans.saved }), [...planFields, 'content']),
    served: [turn.status, pick(turn.body.prompt, ['promptId', 'text']), turn.body.injection],
  };
}
