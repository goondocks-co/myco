import { describe, expect, it } from 'bun:test';
import { readAttention } from '@myco-server-worker/core/attention.js';
import { PROMPT_REFERENCE_LOOKBACK_MS, readPromptReferenceHealth } from '@myco-server-worker/read/prompt-reference-health.js';
import { sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_700_000_000_000;
const ZERO = { receipt_selected: 0, answer_selected: 0, receipt_delivered: 0, answer_delivered: 0 };

function fixture() {
  const e = sqliteEnv();
  const { sqlite } = e;
  const session = (id: string, agent = 'claude-code', through: number | null = NOW, offset = 100, role = 'primary') => {
    sqlite.run(`INSERT INTO sessions(project_id,session_id,agent,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES ('proj_1',?,?, 'm','t',1,1)`, [id, agent]);
    sqlite.run(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,size,parsed_offset,first_received_at,last_received_at,token_id,role,parsed_through_at,prompt_identity_scheme)
      VALUES ('proj_1',?,?, 'm',?,100,?,1,1,'t',?,?,'claude-v1')`, [`tx_${id}`, id, agent, offset, role, through]);
  };
  let sequence = 0;
  const reference = (session: string, over: Record<string, unknown> = {}, table = 'spore_injections') => {
    const id = `r_${++sequence}`;
    const row: Record<string, unknown> = { project_id: 'proj_1', id, session_id: session, prompt_id: id, ask_protocol: 'v1', asked_at: NOW - 100, created_at: NOW - 50,
      ...(table === 'spore_injections' ? { prompt_hash: 'ask', spore_ids: '[]' } : { outcome: 'served', context_chars: 1, parts: '[]', skipped: '[]', failures: '[]', selection: '{}' }), ...over };
    sqlite.run(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row) as never[]);
    return id;
  };
  const answer = (session: string, over: Record<string, unknown> = {}) => reference(session, over, 'prompt_context_answers');
  const read = () => readAttention(e.serverEnv, NOW);
  return { ...e, session, reference, answer, read };
}

describe('prompt references in Needs you', () => {
  it('returns the four reference counts, once parse has caught up past each reference', async () => {
    const f = fixture();
    try {
      f.session('s');
      f.reference('s', { delivered_prompt_id: 'missing-delivery', delivered_at: NOW - 20 });
      f.answer('s', { delivered_prompt_id: 'missing-delivery', delivered_at: NOW - 20 });
      const item = (await f.read()).items.find(i => i.kind === 'prompt_references');
      expect(item).toMatchObject({ kind: 'prompt_references', tone: 'warn', total: 4, since: NOW - PROMPT_REFERENCE_LOOKBACK_MS,
        dangling: { receipt_selected: 1, answer_selected: 1, receipt_delivered: 1, answer_delivered: 1 } });
      f.sqlite.run(`INSERT INTO prompt_batches(project_id,prompt_id,session_id,event_id,origin,content_hash,created_at,updated_at,token_id,received_at)
        SELECT project_id,prompt_id,session_id,id,'user','h',1,1,'t',1 FROM spore_injections`);
      f.sqlite.run(`UPDATE spore_injections SET delivered_prompt_id=prompt_id`);
      f.sqlite.run(`UPDATE prompt_context_answers SET prompt_id=(SELECT prompt_id FROM spore_injections),delivered_prompt_id=(SELECT prompt_id FROM spore_injections)`);
      expect((await f.read()).items).toEqual([]);
    } finally { f.sqlite.close(); }
  });

  for (const state of ['early', 'not-caught-up', 'undated', 'equal', 'delegated', 'legacy', 'session-wide', 'tombstoned', 'before-window'] as const) {
    it(`does not raise attention for ${state} references`, async () => {
      const f = fixture();
      try {
        f.session('s', 'claude-code', state === 'early' ? NOW - 200 : state === 'undated' ? null : state === 'equal' ? NOW - 100 : NOW,
          state === 'not-caught-up' ? 50 : 100, state === 'delegated' ? 'subagent' : 'primary');
        const over = { ...(state === 'legacy' ? { ask_protocol: 'legacy' } : {}),
          ...(state === 'session-wide' ? { prompt_id: null, scope_reason: 'absent_key' } : {}),
          ...(state === 'before-window' ? { created_at: NOW - PROMPT_REFERENCE_LOOKBACK_MS - 1 } : {}) };
        f.reference('s', over);
        f.answer('s', over);
        if (state === 'tombstoned') f.sqlite.run(`INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES ('proj_1','s',1,'m')`);
        expect(await f.read()).toEqual({ items: [], unavailable: [] });
      } finally { f.sqlite.close(); }
    });
  }

  it('raises a hash mismatch alone and reports per-agent reason shares while excluding tombstoned answers', async () => {
    const f = fixture();
    try {
      f.session('c', 'codex');
      f.session('s');
      const id = f.reference('c');
      f.sqlite.run(`INSERT INTO prompt_batches(project_id,prompt_id,session_id,event_id,origin,content_hash,prompt_key_hash,created_at,updated_at,token_id,received_at)
        VALUES ('proj_1',?,'c','e','user','h','different',1,1,'t',1)`, [id]);
      f.answer('c', { prompt_id: id, asked_at: NOW - 100 });
      f.answer('c', { prompt_id: null, scope_reason: 'steering', asked_at: NOW - 200 });
      f.answer('c', { prompt_id: null, scope_reason: 'absent_key', asked_at: NOW - 300 });
      f.answer('c', { ask_protocol: 'legacy', asked_at: null });
      f.answer('s', { ask_protocol: 'legacy', asked_at: null });
      f.answer('s', { prompt_id: null, scope_reason: 'transcript_only' });
      f.session('gone', 'codex');
      f.answer('gone', { prompt_id: null, scope_reason: 'scheme' });
      f.answer('gone', { ask_protocol: 'legacy', asked_at: null });
      f.sqlite.run(`INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES ('proj_1','gone',1,'m')`);
      const item = (await f.read()).items.find(i => i.kind === 'prompt_references');
      expect(item).toMatchObject({ total: 0, dangling: ZERO, agents: [
        { agent: 'claude-code', asks: 2, sessionScoped: 1, scopeReasons: { transcript_only: { asks: 1, share: 0.5 } }, legacy: 1, sessionScopedShare: 0.5, legacyShare: 0.5, keyMismatches: 0 },
        { agent: 'codex', asks: 4, sessionScoped: 2, scopeReasons: { steering: { asks: 1, share: 0.25 }, absent_key: { asks: 1, share: 0.25 } }, legacy: 1, sessionScopedShare: 0.5, legacyShare: 0.25, keyMismatches: 1 },
      ] });
      f.sqlite.run(`UPDATE prompt_batches SET prompt_key_hash='ask'`);
      expect(await f.read()).toEqual({ items: [], unavailable: [] });
    } finally { f.sqlite.close(); }
  });

  it('does not raise attention for a mismatch before the window', async () => {
    const f = fixture();
    try {
      f.session('c', 'codex');
      const id = f.reference('c', { created_at: NOW - PROMPT_REFERENCE_LOOKBACK_MS - 1 });
      f.sqlite.run(`INSERT INTO prompt_batches(project_id,prompt_id,session_id,event_id,origin,content_hash,prompt_key_hash,created_at,updated_at,token_id,received_at)
        VALUES ('proj_1',?,'c','e','user','h','different',1,1,'t',1)`, [id]);
      expect(await f.read()).toEqual({ items: [], unavailable: [] });
    } finally { f.sqlite.close(); }
  });

  it('counts dated retries once per session and ask instant, and undated answers by their own id', async () => {
    const f = fixture();
    try {
      f.session('c', 'codex');
      f.session('other', 'codex');
      for (let retry = 0; retry < 2; retry++) {
        f.answer('c', { prompt_id: null, scope_reason: 'steering', asked_at: NOW - 500 });
        f.answer('c', { ask_protocol: 'legacy', asked_at: NOW - 400 });
        f.answer('c', { ask_protocol: 'legacy', asked_at: null });
        f.answer('c', { asked_at: NOW - 300 });
      }
      f.answer('other', { prompt_id: null, scope_reason: 'scheme', asked_at: NOW - 500 });
      expect((await readPromptReferenceHealth(f.serverEnv.db, NOW)).agents).toEqual([
        { agent: 'codex', asks: 6, sessionScoped: 2, scopeReasons: { steering: { asks: 1, share: 1/6 }, scheme: { asks: 1, share: 1/6 } },
          legacy: 3, sessionScopedShare: 2/6, legacyShare: 0.5, keyMismatches: 0 },
      ]);
    } finally { f.sqlite.close(); }
  });

  it('names a failed reference read and still answers the other rules', async () => {
    const f = fixture();
    try {
      const db = f.serverEnv.db;
      const answer = await readAttention({ ...f.serverEnv, db: { ...db, prepare(sql) {
        if (sql.includes('CROSS JOIN spore_injections r')) throw new Error('reference read failed');
        return db.prepare(sql);
      } } }, NOW);
      expect(answer).toEqual({ items: [], unavailable: ['prompt_references'] });
    } finally { f.sqlite.close(); }
  });
});
