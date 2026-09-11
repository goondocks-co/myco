import { describe, expect, it } from 'bun:test';
import { listUnprocessedPrompts, markPromptProcessed } from '@myco-server-worker/read/prompts.js';
import { sqliteEnv } from './helpers/fixtures.js';

function setup() {
  const env = sqliteEnv();
  const session = (id: string, endedAt: number | null, project = 'proj_1') => {
    env.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, ended_at)
      VALUES (?, ?, 'm', 't', 1, 1, ?)`, [project, id, endedAt]);
  };
  const prompt = (sessionId: string, id: string, createdAt: number, origin = 'user', project = 'proj_1') => {
    env.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
      VALUES (?, ?, ?, ?, ?, ?, 'h', ?, ?, 't', ?)`, [project, sessionId, id, id, `body ${id}`, origin, createdAt, createdAt, createdAt]);
  };
  const read = (limit = 20, cursor?: string) => listUnprocessedPrompts(env.db, { projectId: 'proj_1' }, { limit, cursor });
  return { ...env, session, prompt, read };
}

describe('extraction prompt selection', () => {
  it('reads a newly completed session before a large backlog and fills unused space with history', async () => {
    const e = setup();
    e.session('old', 100);
    e.session('fresh', 200);
    for (let i = 0; i < 100; i++) e.prompt('old', `old_${i}`, i);
    e.prompt('fresh', 'fresh_1', 150);
    e.prompt('fresh', 'fresh_2', 160);
    const page = await e.read();
    expect(page.rows.map((p) => p.promptId)).toEqual(['fresh_1', 'fresh_2', ...Array.from({ length: 18 }, (_, i) => `old_${i}`)]);
    for (const p of page.rows) await markPromptProcessed(e.db, { projectId: 'proj_1' }, p.promptId);
    expect((await e.read()).rows.map((p) => p.promptId)).toEqual(Array.from({ length: 20 }, (_, i) => `old_${i + 18}`));
  });

  it('keeps both partitions moving in conversation order across pages and pins the session while new work arrives', async () => {
    const e = setup();
    e.session('old', 100);
    e.session('fresh', 200);
    for (let i = 0; i < 40; i++) {
      e.prompt('old', `old_${i}`, i);
      e.prompt('fresh', `fresh_${i}`, 100 + i);
    }
    const first = await e.read();
    expect(first.rows.filter((p) => p.sessionId === 'fresh').map((p) => p.promptId)).toEqual(Array.from({ length: 15 }, (_, i) => `fresh_${i}`));
    expect(first.rows.filter((p) => p.sessionId === 'old').map((p) => p.promptId)).toEqual(Array.from({ length: 5 }, (_, i) => `old_${i}`));
    e.session('newer', 300);
    e.prompt('newer', 'newer_1', 250);
    const seen = [...first.rows];
    let cursor = first.cursor;
    while (cursor !== null) {
      const next = await e.read(20, cursor);
      expect(next.rows.length).toBeGreaterThan(0);
      seen.push(...next.rows);
      cursor = next.cursor;
    }
    expect(seen).toHaveLength(81);
    expect(new Set(seen.map((p) => p.promptId)).size).toBe(81);
    for (const id of ['old', 'fresh']) expect(seen.filter((p) => p.sessionId === id).map((p) => p.createdAt))
      .toEqual(Array.from({ length: 40 }, (_, i) => i + (id === 'fresh' ? 100 : 0)));
    expect((await e.read()).rows[0].promptId).toBe('newer_1');
  });

  it('shares unused historical space and uses completion time rather than prompt age', async () => {
    const e = setup();
    e.session('older', 100);
    e.session('long-session', 200);
    e.prompt('older', 'old', 99);
    for (let i = 0; i < 30; i++) e.prompt('long-session', `fresh_${i}`, i);
    const page = await e.read();
    expect(page.rows).toHaveLength(20);
    expect(page.rows.filter((p) => p.sessionId === 'long-session')).toHaveLength(19);
    expect(page.rows.at(-1)?.promptId).toBe('old');
  });

  it('does not select completed sessions with only injected or processed prompts, another project, or an open session', async () => {
    const e = setup();
    e.session('eligible', 100);
    e.session('injected', 200);
    e.session('processed', 300);
    e.session('open', null);
    e.session('foreign', 400, 'proj_2');
    e.prompt('eligible', 'yes', 1, 'unknown');
    e.prompt('injected', 'system', 2, 'system');
    e.prompt('processed', 'done', 3);
    e.prompt('open', 'open', 4);
    e.prompt('foreign', 'foreign', 5, 'user', 'proj_2');
    await markPromptProcessed(e.db, { projectId: 'proj_1' }, 'done');
    expect((await e.read()).rows.map((p) => p.promptId)).toEqual(['yes']);
  });

  it('continues an already issued chronological cursor and never restarts malformed extraction cursors', async () => {
    const e = setup();
    e.session('s', 100);
    e.prompt('s', 'a', 1);
    e.prompt('s', 'b', 2);
    expect((await e.read(20, '1:a')).rows.map((p) => p.promptId)).toEqual(['b']);
    await expect(e.read(20, 'ex1:garbage')).rejects.toThrow('Invalid extraction cursor');
    await expect(e.read(20, 'ex1:["s",true,null]')).rejects.toThrow('Invalid extraction cursor');
  });
});
