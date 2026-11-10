import { afterEach, describe, expect, it } from 'bun:test';
import { NONE_CARD } from '@myco-server-worker/core/turn-cards.js';
import { renderCard } from '@goondocks/myco-shared/turn-card';
import { SEARCH_WINDOW } from '@goondocks/myco-shared/search-types';
import { SearchRefused } from '@myco-server-worker/core/search-query.js';
import { searchFixture, type SearchFixture } from './helpers/search-fixture.js';

const opened: SearchFixture[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });
const fixture = () => { const f = searchFixture(); opened.push(f); return f; };
const ids = (answer: { hits: { id: string }[] }) => answer.hits.map((hit) => hit.id);
const refusal = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { if (error instanceof SearchRefused) return { code: error.code, message: error.message }; throw error; } return null; };

describe('a word search', () => {
  it('finds every kind with its retrieve hint, keeps another Project out, and never counts its matches', async () => {
    const f = fixture();
    f.session('s1', { title: 'cobalt session' });
    f.spore('sp1', 'cobalt spore body');
    f.plan('pl1', 'cobalt plan body');
    f.card('s1', 't1', 'cobalt card text');
    f.spore('other', 'cobalt elsewhere', {}, 'search-b');
    const answer = await f.search('cobalt', { mode: 'fts' });
    expect(answer.hits.map((hit) => `${hit.type}:${hit.id}`).sort()).toEqual(['card:t1', 'plan:pl1', 'session:s1', 'spore:sp1']);
    expect(answer.hits.find((hit) => hit.type === 'spore')!.retrieve).toEqual({ tool: 'myco_spores', input: { op: 'get', id: 'sp1' } });
    expect(answer.hits.find((hit) => hit.type === 'card')).toMatchObject({ session_id: 's1', prompt_id: 't1' });
    expect(answer).toMatchObject({ mode: 'fts', partial: false, nextCursor: null, coverage: { state: 'ready', pendingBlobs: 0, horizon: null } });
    expect(typeof answer.asOf).toBe('number');
    expect(Object.keys(answer).sort()).toEqual(['asOf', 'coverage', 'hits', 'mode', 'nextCursor', 'partial', 'provider_unavailable']);
  });

  it('ranks records whose headline holds the words first, then the newest, across kinds', async () => {
    const f = fixture();
    f.spore('old-line', 'body words', { agent_line: 'cobalt cache eviction', created_at: 1_000 });
    f.card('s1', 'new-card', 'cobalt cache mentioned in passing', { created_at: 9_000 });
    f.spore('newer-body', 'cobalt cache in the body only', { created_at: 5_000 });
    expect(ids(await f.search('cobalt cache', { mode: 'fts' }))).toEqual(['old-line', 'new-card', 'newer-body']);
  });

  it(`ranks only the newest ${SEARCH_WINDOW} matches of a kind: a better but older match waits for a later page, and with fewer matches it ranks first`, async () => {
    const f = fixture();
    f.spore('best-but-oldest', 'zircon detail', { agent_line: 'zircon', created_at: 1_000 });
    f.sqlite.transaction(() => { for (let i = 0; i < SEARCH_WINDOW - 1; i += 1) f.spore(`s${i}`, 'zircon detail', { created_at: 10_000 + i * 1_000 }); })();
    const few = await f.search('zircon', { mode: 'fts', type: 'spore' });
    expect({ first: few.hits[0]?.id, partial: few.partial }).toEqual({ first: 'best-but-oldest', partial: false });
    f.spore('one-more', 'zircon detail', { created_at: 900_000_000 });
    const many = await f.search('zircon', { mode: 'fts', type: 'spore' });
    expect(ids(many)).not.toContain('best-but-oldest');
    expect(many.partial).toBe(true);
    expect(many.coverage.horizon).not.toBeNull();
    expect(many.nextCursor).not.toBeNull();
  });

  it('narrows by status, type, session, agent, branch and time, and leaves out kinds a filter cannot match', async () => {
    const f = fixture();
    f.session('sa', { title: 'unrelated', agent: 'codex', branch: 'main' });
    f.session('sb', { title: 'unrelated', agent: 'claude-code', branch: 'dev' });
    f.spore('active', 'basalt', { session_id: 'sa', created_at: 2_000_000 });
    f.spore('superseded', 'basalt', { status: 'superseded', session_id: 'sb', created_at: 3_000_000 });
    f.spore('decision', 'basalt', { observation_type: 'decision', session_id: 'sb', created_at: 4_000_000 });
    f.card('sa', 'turn', 'basalt card', { created_at: 5_000_000 });
    const search = async (options: Record<string, string | number>) => ids(await f.search('basalt', { mode: 'fts', ...options })).sort();
    expect(await search({ status: 'superseded' })).toEqual(['superseded']);
    expect(await search({ observation_type: 'decision' })).toEqual(['decision']);
    expect(await search({ session_id: 'sa' })).toEqual(['active', 'turn']);
    expect(await search({ agent: 'claude-code' })).toEqual(['decision', 'superseded']);
    expect(await search({ branch: 'main' })).toEqual(['active', 'turn']);
    expect(await search({ since: 3_000, until: 4_000 })).toEqual(['decision', 'superseded']);
  });

  it('searches rendered card values without indexing the wire grammar, and shows a harness prompt as the session shows it', async () => {
    const f = fixture();
    f.session('s1');
    f.card('s1', 'rendered', renderCard({ ...NONE_CARD('x'), asked: 'Run it', done: 'Ran the build.\nsweepbatch failed once', errors: [{ error: 'first line\nENOSPC while writing', fix: 'freed disk' }] }));
    for (const query of ['sweepbatch', 'ENOSPC']) {
      const answer = await f.search(query, { mode: 'fts', type: 'card' });
      expect(ids(answer)).toEqual(['rendered']);
      expect(answer.hits[0]!.preview).not.toContain('Myco card v1');
    }
    for (const query of ['myco', 'files', 'commands']) expect((await f.search(query, { mode: 'fts', type: 'card' })).hits).toEqual([]);
    f.sqlite.run("UPDATE sessions SET agent = 'claude-code' WHERE session_id = 's1'");
    f.card('s1', 'envelope', '<system-reminder>cobalt guidance</system-reminder>Ship the change');
    expect((await f.search('cobalt', { mode: 'fts', type: 'card' })).hits[0]?.preview).toBe('Ship the change');
  });

  it('previews a record without a line from the text around the word it matched', async () => {
    const f = fixture();
    f.plan('long', `${'opening words '.repeat(60)}the obsidian clause sits here ${'closing words '.repeat(60)}`);
    const [hit] = (await f.search('obsidian', { mode: 'fts' })).hits;
    expect(hit!.preview).toContain('obsidian clause');
    expect(hit!.preview.startsWith('…')).toBe(true);
  });

  it('treats operator words and punctuation as text', async () => {
    const f = fixture();
    f.spore('operators', 'NOT NEAR literal words');
    f.spore('version', 'released in 1.4 today');
    expect(ids(await f.search('NOT NEAR', { mode: 'fts' }))).toEqual(['operators']);
    expect(ids(await f.search('1.4', { mode: 'fts' }))).toEqual(['version']);
  });

  it('refuses what it cannot search, naming what to send instead', async () => {
    const f = fixture();
    expect(await refusal(f.search('the of and', { mode: 'fts' }))).toMatchObject({ code: 'stopwords_only' });
    expect((await refusal(f.search('word '.repeat(17), { mode: 'fts' })))?.message).toContain('at most 16');
    expect((await refusal(f.search('a'.repeat(513), { mode: 'fts' })))?.message).toContain('1–512');
    expect((await refusal(f.search('cobalt', { type: 'prompt' })))?.message).toContain('send type card');
    expect((await refusal(f.search('cobalt\u0007', {})))?.code).toBe('invalid_query');
    expect((await refusal(f.search('cobalt', { mode: 'fts', cursor: 'not-a-cursor' })))?.code).toBe('cursor_foreign');
    expect((await refusal(f.search('cobalt', { order: 'time', type: 'session' })))?.message).toContain('use type spore, plan or card');
  });
});

describe('a search by time', () => {
  it('lists one kind oldest first and continues to every match once, whatever the page size', async () => {
    const f = fixture();
    f.session('s1');
    f.sqlite.transaction(() => { for (let i = 0; i < 23; i += 1) f.card('s1', `t${String(i).padStart(2, '0')}`, 'garnet turn', { created_at: 1_000 + Math.floor(i / 5) * 1000 }); })();
    for (const limit of [1, 4, 10]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 40; page += 1) {
        const answer = await f.search('garnet', { mode: 'fts', type: 'card', order: 'time', session_id: 's1', limit, ...(cursor === undefined ? {} : { cursor }) });
        seen.push(...ids(answer));
        if (answer.nextCursor === null) break;
        cursor = answer.nextCursor;
      }
      expect(seen).toHaveLength(23);
      expect(new Set(seen).size).toBe(23);
      const times = seen.map((id) => Math.floor(Number(id.slice(1)) / 5));
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });
});

describe('the turn a card hit names', () => {
  it('gives each hit its own time and the turn it opens, only where the Project\'s session holds the prompt', async () => {
    const f = fixture();
    f.session('s');
    f.session('other');
    for (const session of ['s', 'other']) f.insert('session_documents', { project_id: 'search-a', session_id: session, state: 'live', generation: 1, updated_at: 1 });
    f.insert('session_prompts', { project_id: 'search-a', session_id: 's', generation: 1, prompt_id: 'turn', turn_key: 'turn', ord: 0, created_at: 1000, preview: 'opening request', text_chars: 15 });
    f.card('s', 'turn', 'cobalt answer', { created_at: 2000 });
    f.card('other', 'turn', 'cobalt answer', { created_at: 2100 });
    f.card('s', 'never-captured', 'cobalt answer', { created_at: 2200 });
    const hits = (await f.search('cobalt', { mode: 'fts', type: 'card', limit: 100 })).hits;
    expect(hits.map((r) => [r.session_id, r.id, r.created_at, r.turn]).sort()).toEqual([
      ['other', 'turn', 2100, null],
      ['s', 'never-captured', 2200, null],
      ['s', 'turn', 2000, { prompt_id: 'turn', preview: 'opening request', text_chars: 15, stored: false }],
    ]);
    f.spore('sp', 'cobalt advice', { created_at: 3000 });
    const spore = (await f.search('cobalt', { mode: 'fts', type: 'spore' })).hits[0]!;
    expect(spore.created_at).toBe(3000);
    expect('turn' in spore).toBe(false);
  });
});
