import { expectRunRefusal } from '../../helpers/run-refusal.js';
import { expect } from 'bun:test';
import { mcp as tool, runTool } from '../clients/requests.ts';
import { captureSession, takeRun, failRun } from '../clients/runs.ts';
import { promptContext, deliver, publishedTurns, withRecall, learningSettings, cardSession } from '../clients/capture.ts';
import { expectPersisted, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * Spores on both targets: a member's save naming its session carries that
 * session, a supersede reads as lineage in both
 * directions through the tool and through the owner route, and the record of
 * what a prompt was served reaches the session explorer under the prompt that
 * carried it, and a session's spores page by cursor past writes between pages.
 */
export const spores: ParityScenario = {
  name: 'spores: session citation on a save, lineage both ways, the injection under its turn',
  dedicated: { cloudflare: { embeddingFixture: true }, sqliteVec: true, timeoutMs: 180_000 },
  async run(target: ParityTarget) {
    await withRecall(target, async () => {
      const post = async (sessionId: string, kind: string, payload: Record<string, unknown>, createdAt = Date.now()) => {
        const res = await fetch(`${target.url}/events`, {
          method: 'POST',
          headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
        });
        await expectPersisted(res, kind);
      };
      const owner = async <T,>(path: string): Promise<{ status: number; body: T }> => {
        const res = await fetch(`${target.url}${path}`, { headers: { ...target.ownerHeaders(), origin: target.url } });
        return { status: res.status, body: (await res.json()) as T };
      };
      const mcp = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const res = await fetch(`${target.url}/mcp`, {
          method: 'POST',
          headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_spores', arguments: args } }),
        });
        expect(res.status).toBe(200);
        return ((await res.json()) as { result: { structuredContent: { result: Record<string, unknown> } } }).result.structuredContent.result;
      };

      const stamp = Date.now();
      const session = `parity-spores-${stamp}`;
      const [p1, p2] = [crypto.randomUUID(), crypto.randomUUID()];
      await post(session, 'session.start', { agent: 'claude-code', branch: 'spores', startedAt: stamp }, stamp);
      await post(session, 'prompt', { promptId: p1, text: `What did we settle on ${stamp}`, origin: 'user' }, stamp + 1);
      await post(session, 'prompt', { promptId: p2, text: 'and carry on with it', origin: 'user' }, stamp + 2);

      await publishedTurns(target, session, rows => rows.length === 2);
      // A save cites its canonical source session.
      const first = await mcp({ op: 'save', type: 'decision', content: `recency is the selector ${stamp}`, agent_line: 'When selecting context, rank observations by recency.', session_id: session, prompt_id: p1, project: target.projectId });
      const oldId = String(first.id);
      expect(await mcp({ op: 'get', id: oldId })).toMatchObject({ session_id: session, status: 'active' });

      // A session the caller's machine does not hold is one refusal, whatever the cause.
      const refused = await mcp({ op: 'save', type: 'decision', content: 'nowhere', agent_line: 'When citing evidence, name the session that holds it.', session_id: `no-such-${stamp}`, project: target.projectId });
      expect(refused.error).toBe('session_id not found');

      // A supersede reads as lineage from both ends, through the tool and the owner route.
      const replacementLine = `When selecting context, cap the recency window ${stamp}.`;
      const second = await mcp({ op: 'save', type: 'decision', content: `recency with a cap ${stamp}`, agent_line: replacementLine, session_id: session, project: target.projectId });
      const newId = String(second.id);
      expect(await mcp({ op: 'supersede', old_spore_id: oldId, new_spore_id: newId, reason: 'narrowed', session_id: session, project: target.projectId }))
        .toEqual({ old_spore: oldId, new_spore: newId, status: 'superseded' });

      const older = await mcp({ op: 'get', id: oldId });
      expect([older.status, older.superseded_by, older.predecessors]).toEqual(['superseded', [newId], []]);
      const newer = await mcp({ op: 'get', id: newId });
      expect([newer.status, newer.superseded_by, newer.predecessors]).toEqual(['active', [], [oldId]]);

      const detail = await owner<{ spore: { id: string; status: string }; supersededBy: string[]; supersedes: string[] }>(`/api/projects/${target.projectId}/spores/${oldId}`);
      expect(detail.status).toBe(200);
      expect([detail.body.spore.status, detail.body.supersededBy, detail.body.supersedes]).toEqual(['superseded', [newId], []]);
      const replacement = await owner<{ supersededBy: string[]; supersedes: string[] }>(`/api/projects/${target.projectId}/spores/${newId}`);
      expect([replacement.body.supersededBy, replacement.body.supersedes]).toEqual([[], [oldId]]);

      // The record of what a prompt's text selected reaches the turn body under the prompt that carried it.
      await target.primeEmbedding!(target.projectId);
      const answer = await promptContext(target, session, p1, `recency with a cap ${stamp}`);
      expect(answer.receiptId).toEqual(expect.any(String));
      await deliver(target, session, { receiptId: answer.receiptId, answerId: answer.answerId }, { renderedIn: p2 });

      interface Turn { injection: { sporeIds: string[]; createdAt: number; spores: { id: string; observationType: string; preview: string }[] } | null }
      const base = `/api/projects/${target.projectId}/sessions/${session}`;
      const served = await owner<Turn>(`${base}/turns/${p2}`);
      expect(served.status).toBe(200);
      expect(served.body.injection?.sporeIds).toEqual([newId]);
      expect(served.body.injection?.spores).toEqual([{ id: newId, observationType: 'decision', preview: replacementLine }]);

      // The selecting prompt, delivered nothing, answers null rather than an empty shape.
      expect((await owner<Turn>(`${base}/turns/${p1}`)).body.injection).toBeNull();

      // Imported history keeps cursor order across tied instants and arrivals between pages.
      const imported = async (id: string, createdAt: number) => {
        const response = await fetch(`${target.url}/spores/save`, { method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ id, channel: 'import', agentId: 'paging-history', sessionId: session, observationType: 'gotcha', content: `seeded ${id}`, createdAt }) });
        await expectPersisted(response, 'historical spore');
      };
      const ties = [`tie-a-${stamp}`, `tie-b-${stamp}`, `tie-c-${stamp}`];
      for (const id of ties) await imported(id, stamp - 10);
      const ordered = [newId, oldId, ...ties.reverse()];
      type SporePage = { spores: { id: string }[]; cursor: string | null; total: number };
      const list = `/api/projects/${target.projectId}/spores?session=${encodeURIComponent(session)}&limit=2`;
      const opening = await owner<SporePage>(list);
      expect([opening.status, opening.body.spores.map((s) => s.id), opening.body.total]).toEqual([200, ordered.slice(0, 2), ordered.length]);
      await imported(`arrived-${stamp}`, Date.now() + 60_000);
      await imported(`backfilled-${stamp}`, stamp - 1_000);
      const walked = opening.body.spores.map((s) => s.id);
      let cursor = opening.body.cursor;
      while (cursor !== null) {
        const next = await owner<SporePage>(`${list}&cursor=${encodeURIComponent(cursor)}`);
        expect(next.status).toBe(200);
        walked.push(...next.body.spores.map((s) => s.id));
        cursor = next.body.cursor;
      }
      expect(walked).toEqual([...ordered, `backfilled-${stamp}`]);
      expect((await owner(`${list}&cursor=nope`)).status).toBe(400);
      expect((await owner(`${list}&offset=2&cursor=${encodeURIComponent(opening.body.cursor!)}`)).status).toBe(400);
      // Totals are the maintained counts on every store: a session's, a Project's by type, and across Projects with facets.
      const all = await owner<SporePage>(`/api/projects/${target.projectId}/spores?session=${session}&limit=100`);
      expect(all.body.total).toBe(ordered.length + 2);
      const gotchas = await owner<SporePage>(`/api/projects/${target.projectId}/spores?session=${session}&type=gotcha&limit=1`);
      expect(gotchas.body.total).toBe(5);
      const projectList = await owner<SporePage>(`/api/projects/${target.projectId}/spores?limit=100`);
      const across = await owner<SporePage & { facets?: { project: Record<string, number> } }>(`/api/spores?project=${target.projectId}&limit=1`);
      expect([across.body.total, across.body.facets?.project[target.projectId]]).toEqual([projectList.body.spores.length, projectList.body.spores.length]);
      expect((await owner(`/api/projects/${target.projectId}/spores?q=seeded`)).status).toBe(400);
    });
  },
};


/** Lifecycle changes invalidate a run's stale revision without a body-edit fixture. */
export const guardedSpores: ParityScenario = {
  name: 'spores: guarded resolutions, editorial expectations and per-source revisions',
  dedicated: { timeoutMs: 180_000 },
  async run(target) {
    await learningSettings(target);
    await captureSession(target, 'guarded-spores', 'Review the Project knowledge.', { ended: true, at: Date.now() - 3_600_000 });
    await cardSession(target, 'guarded-spores', 'Review the Project knowledge.');
    const run = await takeRun(target);
    expect(run.task).toBe('extract-curate');
    await runTool(target, run, 'myco_run_learning', { op: 'material' });
    const member = (args: Record<string, unknown>) => tool(target, 'myco_spores', args) as Promise<any>;
    const save = async () => String((await member({ op: 'save', type: 'gotcha', content: crypto.randomUUID(), agent_line: 'When retiring a finding, reread its revision.' })).id);
    const resolve = (args: Record<string, unknown>) => runTool<any>(target, run, 'myco_spores', args);
    const id = await save(), successor = await save();
    expect((await runTool<any>(target, run, 'myco_run_spores', { op: 'get', id })).spore.revision).toBe(0);
    expect((await runTool<any>(target, run, 'myco_run_spores', { op: 'list' })).spores.find((row: any) => row.id === id).revision).toBe(0);
    expectRunRefusal(await resolve({ op: 'obsolete', id, reason: 'missing revision' }), 'expect_revision is required', { tool: 'myco_spores', op: 'obsolete' });
    const obsolete = { op: 'obsolete', id, reason: 'parallel retirement', expect_revision: 0 };
    const raced = await Promise.all([resolve({ op: 'supersede', old_spore_id: id, new_spore_id: successor, expect_revision: 0 }), resolve(obsolete)]);
    expect(raced.filter(result => result.ok === false)).toHaveLength(1);
    const current = await member({ op: 'get', id });
    expect(current.revision).toBe(1);
    expectRunRefusal(raced.find(result => result.ok === false), `source is ${current.status} at revision 1; expected active at revision 0`, { tool: 'myco_run_spores', op: 'get', id });
    expectRunRefusal(await resolve({ ...obsolete, expect_revision: 1, expect_status: current.status }), 'runs require active', { tool: 'myco_spores', op: 'obsolete' });
    const ids = [await save(), await save()];
    await member({ op: 'obsolete', id: ids[1], reason: 'Knowledge retired.' });
    const stale = await member({ op: 'consolidate', source_spore_ids: ids.map(id => ({ id, revision: 0 })), consolidated_content: 'combined', observation_type: 'wisdom', agent_line: 'When combining findings, reread their revisions.' });
    expect(stale).toMatchObject({ ok: false, error: 'stale', spore_id: ids[1], status: 'obsolete', revision: 1 });
    expect((await member({ op: 'get', id: ids[0] })).status).toBe('active');
    expect((await member({ op: 'get', id: ids[1] })).status).toBe('obsolete');
    expect(await failRun(target, run)).toMatchObject({ ended: true });
  },
};
