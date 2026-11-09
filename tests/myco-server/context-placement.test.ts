/**
 * Where a context delivery landed: selected, delivered, unnamed or unavailable, kept apart as receipts and answers land,
 * prompts arrive late, generations flip and sessions are deleted, and read from day counters for the status line.
 */
import { describe, expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { deliveriesNotPlaced } from '@myco-server-worker/db/sessions/placement.js';
import { hookPlacementStatusLine } from '@myco/server/hook-placement-status.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { measuredStore } from './helpers/read-budget.js';
import { sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const P = 'proj_1';

function rig() {
  const e = sqliteEnv();
  e.sqlite.run(`INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at) VALUES (?, 's', 't', 1, 1)`, [P]);
  const generation = (n: number, state = 'live') => e.sqlite.run(`INSERT INTO session_documents(project_id,session_id,state,generation,updated_at) VALUES (?, 's', ?, ?, 1)
    ON CONFLICT DO UPDATE SET state=excluded.state,generation=excluded.generation`, [P, state, n]);
  const prompt = (id: string, gen = 1) => e.sqlite.run(`INSERT INTO session_prompts(project_id,session_id,generation,prompt_id,turn_key,ord,origin,created_at,preview,thread_label) VALUES (?, 's', ?, ?, ?, 1, 'user', 1, 'x', 'main')`, [P, gen, id, id]);
  const receipt = (id: string, hint: string | null, over: { delivered?: boolean; at?: number } = {}) => e.sqlite.run(`INSERT INTO spore_injections(project_id,session_id,id,prompt_id,prompt_hash,spore_ids,created_at,delivered_at,delivered_prompt_id,delivered_scope_reason)
    VALUES (?, 's', ?, ?, ?, '[]', ?, ?, ?, ?)`, [P, id, 'selection-' + id, id, over.at ?? NOW, over.delivered === false ? null : NOW, hint, hint === null && over.delivered !== false ? 'absent_key' : null]);
  const answer = (id: string, delivered: string | null, over: { prompt?: string; receipt?: string; outcome?: string } = {}) => e.sqlite.run(`INSERT INTO prompt_context_answers(project_id,session_id,id,prompt_id,receipt_id,outcome,context_chars,parts,skipped,failures,selection,created_at,delivered_at,delivered_prompt_id,delivered_scope_reason)
    VALUES (?, 's', ?, ?, ?, ?, 0, '[]', '[]', '[]', '{}', ?, ?, ?, ?)`, [P, id, over.prompt ?? 'selected', over.receipt ?? null, over.outcome ?? 'served', NOW, NOW, delivered, delivered === null ? 'absent_key' : null]);
  const state = (id: string) => (e.sqlite.query(`SELECT state FROM context_placements WHERE record_id = ?`).get(id) as { state: string } | null)?.state ?? null;
  const counts = () => deliveriesNotPlaced(e.db, NOW);
  return { ...e, generation, prompt, receipt, answer, state, counts };
}

describe('a delivery\'s placement', () => {
  it('keeps selected, delivered, unnamed and unavailable apart, and counts only the two kinds on no turn', async () => {
    const r = rig();
    r.generation(1);
    r.prompt('p1');
    r.receipt('chosen', null, { delivered: false });
    r.receipt('placed', 'p1');
    r.receipt('no-name', null);
    r.receipt('elsewhere', 'absent');
    expect(['chosen', 'placed', 'no-name', 'elsewhere'].map(r.state)).toEqual(['selected', 'delivered', 'unnamed', 'unavailable']);
    expect(await r.counts()).toEqual({ state: 'ready', unnamed: 1, unavailable: 1 });
  });

  it('counts a served answer with no receipt once, and an answer carrying a receipt as that one receipt', async () => {
    const r = rig();
    r.generation(1);
    r.answer('lone', 'absent');
    r.answer('empty', 'absent', { outcome: 'empty' });
    r.answer('carried', 'absent', { receipt: 'rcp' });
    expect(r.state('lone')).toBe('unavailable');
    expect(r.state('empty')).toBeNull();
    expect(r.state('carried')).toBe('unavailable');
    r.receipt('rcp', 'absent');
    expect(r.state('carried')).toBeNull();
    expect(await r.counts()).toEqual({ state: 'ready', unnamed: 0, unavailable: 2 });
    r.sqlite.run(`DELETE FROM spore_injections WHERE project_id = ? AND id = 'rcp'`, [P]);
    expect(r.state('carried')).toBe('unavailable');
    expect(await r.counts()).toEqual({ state: 'ready', unnamed: 0, unavailable: 2 });
  });

  it('places a delivery when its prompt lands late, by its delivered hint or an answer\'s own prompt', async () => {
    const r = rig();
    r.generation(1);
    r.receipt('waits', 'later');
    r.answer('by-own-prompt', null, { prompt: 'own' });
    expect(['waits', 'by-own-prompt'].map(r.state)).toEqual(['unavailable', 'unnamed']);
    r.prompt('later');
    r.prompt('own');
    expect(['waits', 'by-own-prompt'].map(r.state)).toEqual(['delivered', 'delivered']);
    expect(await r.counts()).toEqual({ state: 'ready', unnamed: 0, unavailable: 0 });
  });

  it('follows the live generation: a flip re-derives every delivery, and prompts of a generation being built do not place one', async () => {
    const r = rig();
    r.generation(1);
    r.prompt('old-prompt');
    r.receipt('on-old', 'old-prompt');
    expect(r.state('on-old')).toBe('delivered');
    r.prompt('rebuilt', 2);
    expect(r.state('on-old')).toBe('delivered');
    r.generation(2);
    expect(r.state('on-old')).toBe('unavailable');
    r.prompt('old-prompt', 2);
    expect(r.state('on-old')).toBe('delivered');
  });

  it('leaves no row for a deleted session, and restores them when the tombstone goes', async () => {
    const r = rig();
    r.generation(1);
    r.receipt('gone', 'absent');
    r.sqlite.run(`INSERT INTO session_tombstones(project_id,session_id,reason,created_at,created_by) VALUES (?, 's', NULL, 1, 'mem_1')`, [P]);
    expect(r.state('gone')).toBeNull();
    expect(await r.counts()).toEqual({ state: 'ready', unnamed: 0, unavailable: 0 });
    r.sqlite.run(`DELETE FROM session_tombstones WHERE project_id = ?`, [P]);
    expect(r.state('gone')).toBe('unavailable');
  });

  it('counts the seven UTC days through today, and moves a retention delete off the counters', async () => {
    const r = rig();
    r.generation(1);
    const dayStart = Math.floor(NOW / DAY) * DAY;
    r.receipt('six', 'absent', { at: dayStart - 6 * DAY });
    r.receipt('seven', 'absent', { at: dayStart - 7 * DAY + 1 });
    expect(await r.counts()).toEqual({ state: 'ready', unnamed: 0, unavailable: 1 });
    r.sqlite.run(`DELETE FROM spore_injections WHERE id = 'six'`);
    expect(await r.counts()).toEqual({ state: 'ready', unnamed: 0, unavailable: 0 });
  });

  it('says building, never zero, until existing deliveries have been walked, and counts each once under replay', async () => {
    const r = rig();
    r.generation(1);
    r.receipt('a', 'absent');
    r.answer('b', 'absent');
    r.sqlite.run('DELETE FROM context_placements');
    r.sqlite.run('DELETE FROM context_placement_days');
    r.sqlite.run(`UPDATE projection_catchup SET done = 0, after_key = '[]', frontier = NULL WHERE projection = 'context_placements'`);
    expect(await r.counts()).toEqual({ state: 'building' });
    expect(await hookPlacementStatusLine(() => r.counts())).toBe('  Context deliveries not placed on a turn (7 UTC days): building');
    for (let i = 0; i < 6 && (await catchUpProjections(r.db, { clock: () => NOW })).more; i += 1);
    expect(await r.counts()).toEqual({ state: 'ready', unnamed: 0, unavailable: 2 });
    r.sqlite.run(`UPDATE projection_catchup SET done = 0, after_key = '[]', frontier = NULL WHERE projection = 'context_placements'`);
    for (let i = 0; i < 6 && (await catchUpProjections(r.db, { clock: () => NOW })).more; i += 1);
    expect(await r.counts()).toEqual({ state: 'ready', unnamed: 0, unavailable: 2 });
    expect(await hookPlacementStatusLine(() => r.counts())).toBe('  Context deliveries not placed on a turn (7 UTC days): 2 (0 named no prompt, 2 named a prompt not held)');
  });

  it('reads for a prompt only the deliveries that name it, however many the session holds, on the store the Deployment runs on', async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response(null)}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
    try {
      const d1 = await mf.getD1Database('DB');
      for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map(sql => d1.prepare(sql)));
      await d1.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(P, P).run();
      const measured = measuredStore(d1);
      const session = async (id: string, placements: number) => {
        await d1.prepare(`INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at) VALUES (?, ?, 't', 1, 1)`).bind(P, id).run();
        await d1.prepare(`INSERT INTO session_documents(project_id,session_id,state,generation,updated_at) VALUES (?, ?, 'live', 1, 1)`).bind(P, id).run();
        await d1.prepare(`INSERT INTO spore_injections(project_id,session_id,id,prompt_id,prompt_hash,spore_ids,created_at,delivered_at,delivered_prompt_id)
          SELECT ?1,?2,'r'||value,'s'||value,'h'||value,'[]',1,2,'elsewhere' FROM json_each(?3)`).bind(P, id, JSON.stringify(Array.from({ length: placements }, (_, n) => n))).run();
        await d1.prepare(`INSERT INTO spore_injections(project_id,session_id,id,prompt_id,prompt_hash,spore_ids,created_at,delivered_at,delivered_prompt_id)
          VALUES (?1,?2,'named','s-named','h-named','[]',1,2,'landing')`).bind(P, id).run();
      };
      const prompts = (project: string, id: string, ids: readonly string[]) => d1.prepare(`INSERT INTO session_prompts(project_id,session_id,generation,prompt_id,turn_key,ord,origin,created_at,preview,thread_label)
        SELECT ?1,?2,1,value,value,1,'user',1,'x','main' FROM json_each(?3)`).bind(project, id, JSON.stringify(ids)).run();
      const cost = async (run: () => Promise<unknown>) => { measured.reset(); await run(); return measured.reads(); };
      const landing = (id: string) => cost(() => prompts(P, id, ['landing']));
      const restore = (id: string) => cost(() => d1.prepare(`DELETE FROM session_prompts WHERE project_id=? AND session_id=? AND generation=1`).bind(P, id).run());
      await session('few', 3);
      await session('many', 1_500);
      await session('zz-after', 0);
      expect(await landing('many')).toBe(await landing('few'));
      expect(await d1.prepare(`SELECT state FROM context_placements WHERE session_id='many' AND record_id='named'`).first()).toEqual({ state: 'delivered' });
      const manyPrompts = Array.from({ length: 30 }, (_, n) => `p${n}`);
      await prompts(P, 'few', manyPrompts);
      await prompts(P, 'many', manyPrompts);
      expect(await restore('many')).toBe(await restore('few'));
      expect(await d1.prepare(`SELECT state FROM context_placements WHERE session_id='many' AND record_id='named'`).first()).toEqual({ state: 'unavailable' });
    } finally { await mf.dispose(); }
  }, 120_000);
});
