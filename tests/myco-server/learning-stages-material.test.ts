import { expect, it } from 'bun:test';
import { MATERIAL_CHANGED, MATERIAL_UNREAD } from '@myco-server-worker/core/material-pages.js';
import { RUN_ANSWER_BYTES } from '@myco-server-worker/core/read-window.js';
import { learningMaterialPages } from '@myco-server-worker/core/learning-sessions.js';
import { withDocumentStores } from './helpers/document-stores.js';
import { beforeWriteBatch } from './helpers/prepared.js';
import { uuid } from './helpers/fixtures.js';
import { EXTRACTION_RULES } from '@myco-server-worker/core/extraction-rules.js';
import { AGENT_LINE_MAX_CHARS, AGENT_LINE_EXAMPLE } from '@myco-server-worker/core/injection.js';
import { STATE_CHANGED } from '@myco-server-worker/mcp/tools/run.js';
import { longTurn, heavyCard, learningRun, plainTurns } from './helpers/learning-stages.ts';

it('serves a learning run\'s slice in answers the harness holds whole, losing nothing', async () => {
  await withDocumentStores(async (db) => {
    const turns = plainTurns(24);
    const handoff = 'the previous slice left this open'.repeat(100);
    const run = await learningRun(db, turns, 'low', (key) => (key === turns[3]!.id ? heavyCard('\u0001', 11_000) : heavyCard('é"\n', 10_800)), handoff);
    const pages = await run.readAll();
    expect(pages.length).toBeGreaterThan(5);

    let page = 0;
    for (const answer of pages) {
      page += 1;
      const held = JSON.stringify((await run.raw('myco_run_learning', { op: 'material', page, revision: answer.revision })).structuredContent);
      expect(new TextEncoder().encode(held).length).toBeLessThanOrEqual(RUN_ANSWER_BYTES);
      expect(answer.handoff).toBe(page === 1 ? handoff : undefined);
    }
    expect(pages[0]!.more_slices).toBe(true);
    expect(pages.some((answer) => answer.cards.some((card) => card.continues === true))).toBe(true);

    const served = new Map<string, string>();
    for (const answer of pages) for (const card of answer.cards) served.set(card.turn_key, (served.get(card.turn_key) ?? '') + card.card);
    const { results } = await db.prepare(`SELECT turn_key AS key, card FROM turn_cards WHERE turn_key IN (SELECT value FROM json_each(?))`).bind(JSON.stringify([...served.keys()])).all<{ key: string; card: string }>();
    expect(results.length).toBe(served.size);
    for (const row of results) expect(served.get(row.key)).toBe(row.card);
    expect(served.get(turns[3]!.id)).toContain('\u0001'.repeat(11_000));
    const past = await run.material({ page: pages.length + 1, revision: pages[0]!.revision });
    if (!('ok' in past) || past.ok !== false || !('error' in past) || typeof past.error !== 'string') throw new Error('Expected a past-end refusal');
    expect(past.error).toContain(`the last valid page is ${pages.length}`);
    expect(past.error).toContain('Next call: myco_spores {"op":"save"}');
    expect(past.error).toContain('then call myco_run_learning op complete');
    expect(past.error).toStartWith('Not read:');
  });
});

it('leaves page 1 of a slice room for what it carries beside its cards', () => {
  const opening = { handoff: 'h\n'.repeat(2_048), more_slices: true, changed_since_assignment: 1 };
  const cards = Array.from({ length: 60 }, (_, at) => ({ turn_key: `turn-${at}`, signal: 'low', card: 'é'.repeat(1_000) }));
  const pages = learningMaterialPages('s', opening, cards);
  expect(pages.length).toBeGreaterThan(2);
  for (const [at, page] of pages.entries()) {
    const answer = { result: { session_id: 's', ...(at === 0 ? opening : {}), revision: '0'.repeat(16), page: at + 1, next_page: at + 2, cards: page } };
    expect(new TextEncoder().encode(JSON.stringify(answer)).length).toBeLessThanOrEqual(RUN_ANSWER_BYTES);
  }
  expect(pages.flat().map((entry) => entry.turn_key)).toEqual(cards.map((card) => card.turn_key));
});

it('refuses a learning run\'s spore writes and completion until this attempt has read every page, and names the next one', async () => {
  await withDocumentStores(async (db) => {
    const turns = plainTurns(8);
    const run = await learningRun(db, turns, 'low', () => heavyCard('é"\n', 10_800));
    const writes = () => [
      run.save('A line.'), run.complete('open'),
      run.call('myco_spores', { op: 'supersede', old_spore_id: 'spr_a', new_spore_id: 'spr_b', expect_revision: 1, reason: 'r' }),
      run.call('myco_spores', { op: 'obsolete', id: 'spr_a', expect_revision: 1, reason: 'r' }),
      run.call('myco_spores', { op: 'consolidate', source_spore_ids: [{ id: 'spr_a', revision: 1 }], consolidated_content: 'c', observation_type: 'wisdom', agent_line: 'A line.', reason: 'r' }),
    ];
    const held = async () => db.prepare(`SELECT (SELECT COUNT(*) FROM spores) AS spores, (SELECT COUNT(*) FROM turn_cards WHERE covered = 1) AS covered, (SELECT COUNT(*) FROM run_served_material WHERE session_id = 'long' AND run_id IN (SELECT id FROM agent_runs WHERE task = 'extract-curate')) AS served`).first<{ spores: number; covered: number; served: number }>();
    for (const refused of await Promise.all(writes())) expect(refused).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 1 });
    expect(await held()).toEqual({ spores: 0, covered: 0, served: 0 });

    const first = await run.material();
    expect(first.next_page).toBe(2);
    const servedOfFirst = (await held())!.served;
    expect(servedOfFirst).toBe(first.cards.length);
    for (const refused of await Promise.all(writes())) expect(refused).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 2, revision: first.revision });
    expect(await run.material({ page: 3, revision: first.revision })).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 2 });
    expect(await run.material({ page: 2 })).toMatchObject({ code: MATERIAL_CHANGED });
    expect(await held()).toEqual({ spores: 0, covered: 0, served: servedOfFirst });

    const second = await run.material({ page: 2, revision: first.revision });
    await db.prepare(`UPDATE turn_cards SET input_hash = 'changed' WHERE turn_key = ?`).bind(turns[7]!.id).run();
    expect(await run.material({ page: second.next_page!, revision: second.revision })).toMatchObject({ ok: false, code: MATERIAL_CHANGED });
    expect(await run.save('A line.')).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 3, revision: first.revision });

    const restarted = await run.readAll();
    expect(restarted[0]!.revision).not.toBe(first.revision);
    expect(restarted[0]!.changed_since_assignment).toBe(1);
    expect(await run.save('When a turn runs long, read every page.')).toMatchObject({ id: expect.any(String) });
    expect(await run.complete('nothing open')).toEqual({ completed: true, covered: 7 });
  });
});

it('leaves a page unread when its served record fails, so completion cannot retire text the run never received', async () => {
  await withDocumentStores(async (db) => {
    const run = await learningRun(db, plainTurns(1), 'high', () => heavyCard('増', 11_700), 'h\n'.repeat(2_048));
    const first = await run.material();
    expect(first.cards[0]!.continues).toBe(true);
    expect(first.next_page).toBe(2);
    let failed = 0;
    run.bindings.MYCO_DB = beforeWriteBatch(db, (sql) => sql.includes('INSERT INTO run_served_material'), async () => { failed += 1; throw new Error('storage down'); }, true);
    expect(await run.raw('myco_run_learning', { op: 'material', page: 2, revision: first.revision })).toBeUndefined();
    run.bindings.MYCO_DB = db;
    expect(failed).toBe(1);
    expect(await run.complete('only page 1 arrived')).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 2 });
    expect(await run.save('A line.')).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 2 });
    expect((await run.material({ page: 2, revision: first.revision })).page).toBe(2);
    expect(await run.complete('all of it arrived')).toEqual({ completed: true, covered: 1 });
  });
});

it('keeps state usable within one answer: a value that cannot fit is refused, and a longer one already held is read in parts with its version', async () => {
  await withDocumentStores(async (db) => {
    const run = await learningRun(db, plainTurns(1), 'low');
    await run.readAll();
    const key = 'long-key';
    expect(await run.call('myco_run', { op: 'state_set', key, value: 'x'.repeat(RUN_ANSWER_BYTES) })).toMatchObject({ ok: false, error: expect.stringContaining('JSON UTF-8 bytes; the limit is') });
    expect(await run.call('myco_run', { op: 'state_set', key, value: '\u0001'.repeat(7_000) })).toMatchObject({ ok: false });
    expect(await run.call('myco_run', { op: 'state_set', key, value: 'short' })).toEqual({ key, applied: true });
    const long = '増"\n'.repeat(30_000);
    await db.prepare(`UPDATE agent_state SET value = ? WHERE key = ?`).bind(long, key).run();

    let read = '';
    let version: unknown;
    for (let offset: number | undefined = 0, parts = 0; offset !== undefined; parts += 1) {
      expect(parts).toBeLessThan(10);
      const held = await run.raw('myco_run', { op: 'state_get', key, ...(offset === 0 ? {} : { offset, version }) });
      expect(new TextEncoder().encode(JSON.stringify(held.structuredContent)).length).toBeLessThanOrEqual(RUN_ANSWER_BYTES);
      const answer = (held.structuredContent as { result: { value: string; version: string; next_offset?: number } }).result;
      read += answer.value;
      version = answer.version;
      offset = answer.next_offset;
    }
    expect(read).toBe(long);
    expect(await run.call('myco_run', { op: 'state_set', key, value: 'smaller', version })).toEqual({ key, applied: true });
    expect(await run.call('myco_run', { op: 'state_get', key, offset: -1 })).toMatchObject({ ok: false });
  });
});

it('refuses a state continuation once the value has changed, so parts of two versions never join and overwrite the newer one', async () => {
  await withDocumentStores(async (db) => {
    const run = await learningRun(db, plainTurns(1), 'low');
    await run.readAll();
    const key = 'shared-key';
    await run.call('myco_run', { op: 'state_set', key, value: 'short' });
    await db.prepare(`UPDATE agent_state SET value = ? WHERE key = ?`).bind('x'.repeat(41_000), key).run();
    const first = await run.call('myco_run', { op: 'state_get', key }) as { value: string; version: string; next_offset: number };
    expect(first.next_offset).toBe(first.value.length);
    const continuation = { op: 'state_get', key, offset: first.next_offset };
    expect(await run.call('myco_run', continuation)).toMatchObject({ ok: false, code: STATE_CHANGED });
    expect((await run.call('myco_run', { ...continuation, version: first.version })).version).toBe(first.version);

    expect(await run.call('myco_run', { op: 'state_set', key, value: 'newer', version: first.version })).toEqual({ key, applied: true });
    const refused = await run.call('myco_run', { ...continuation, version: first.version });
    expect(refused).toMatchObject({ ok: false, code: STATE_CHANGED, error: expect.stringContaining('version is missing') });
    expect(refused).not.toHaveProperty('value');
    expect(refused).not.toHaveProperty('version');
    expect(await run.call('myco_run', { op: 'state_set', key, value: first.value, version: first.version })).toEqual({ key, applied: false });
    expect(await run.call('myco_run', { op: 'state_get', key })).toMatchObject({ value: 'newer' });
  });
});

it('answers a spore get whatever its fields hold, cut to fit, and to less when asked', async () => {
  await withDocumentStores(async (db) => {
    const run = await learningRun(db, plainTurns(1), 'low');
    await run.readAll();
    const saved = await run.call('myco_spores', { op:'save', type:'gotcha', session_id:'long', agent_line:'A spore with a long context.', content:'the body' }) as { id:string };
    expect(await db.prepare('SELECT file_path FROM spores WHERE id=?').bind(saved.id).first()).toEqual({file_path:null});
    await db.prepare(`UPDATE spores SET context = ?, properties = ? WHERE id = ?`).bind('c'.repeat(41_000), '\u0001'.repeat(20_000), saved.id).run();
    const held = await run.raw('myco_run_spores', { op: 'get', id: saved.id });
    expect(new TextEncoder().encode(JSON.stringify(held.structuredContent)).length).toBeLessThanOrEqual(RUN_ANSWER_BYTES);
    expect((held.structuredContent as { result: { truncated: boolean; spore: { id: string; revision: number; content: string } } }).result)
      .toMatchObject({ truncated: true, spore: { id: saved.id, revision: expect.any(Number), content: 'the body' } });
    const less = await run.call('myco_run_spores', { op: 'get', id: saved.id, max_chars: 10 }) as { truncated: boolean; spore: { context: string } };
    expect(less).toMatchObject({ truncated: true, spore: { context: 'c'.repeat(10) } });
    expect(await run.call('myco_run_spores', { op: 'get', id: saved.id, max_chars: 0 })).toMatchObject({ ok: false, error: expect.stringContaining('max_chars') });
    const whole = await run.save('Another spore, no long fields.', 'a short body') as { id: string };
    expect(await run.call('myco_run_spores', { op: 'get', id: whole.id })).toMatchObject({ truncated: false, spore: { content: 'a short body' } });
  });
});

it('answers a learning run\'s save with the closest active spores, and that is enough to supersede and consolidate', async () => {
  await withDocumentStores(async (db) => {
    const run = await learningRun(db, plainTurns(2), 'low');
    await run.readAll();
    const fullReads = () => db.prepare(`SELECT COUNT(*) AS n FROM agent_run_events WHERE tool_name = 'myco_run_spores'`).first<{ n: number }>();

    const first = await run.save(AGENT_LINE_EXAMPLE) as { id: string; near_matches: unknown[] };
    expect(first.near_matches).toEqual([]);
    const second = await run.save('Declaring a run tool op in WRITE_OPS keeps dry runs from writing (packages/myco-server/src/core/tool-catalogue.ts).') as { id: string; near_matches: unknown[] };
    expect(second.near_matches).toEqual([{ id: first.id, revision: expect.any(Number), observation_type: 'gotcha', agent_line: AGENT_LINE_EXAMPLE }]);
    const near = second.near_matches[0] as { id: string; revision: number };

    expect(await run.call('myco_spores', { op: 'supersede', old_spore_id: near.id, new_spore_id: second.id, expect_revision: near.revision, reason: 'says why' }))
      .toMatchObject({ old_spore: near.id, new_spore: second.id, status: 'superseded' });
    expect(await fullReads()).toEqual({ n: 0 });

    const third = await run.save('Another op in WRITE_OPS: same dry-run rule (packages/myco-server/src/core/tool-catalogue.ts).') as { id: string; revision: number; near_matches: { id: string; revision: number }[] };
    expect(third.near_matches.map((match) => match.id)).toEqual([second.id]);
    expect(await run.call('myco_spores', { op: 'consolidate', session_id: 'long', source_spore_ids: [{ id: third.id, revision: third.revision }, ...third.near_matches.map(({ id, revision }) => ({ id, revision }))],
      consolidated_content: 'Every write op is declared in WRITE_OPS.', observation_type: 'wisdom', agent_line: 'Every write op is declared in WRITE_OPS.', reason: 'one topic' }))
      .toMatchObject({ status: 'consolidated', sources_consolidated: 2 });
    expect(await fullReads()).toEqual({ n: 0 });
  });
});

it('states the agent line\'s bound in the rules, by an example inside it, and rules out adding by default', () => {
  expect(AGENT_LINE_EXAMPLE.length).toBeLessThanOrEqual(AGENT_LINE_MAX_CHARS);
  expect(EXTRACTION_RULES).toContain(AGENT_LINE_EXAMPLE);
  expect(EXTRACTION_RULES).toContain(`${AGENT_LINE_MAX_CHARS} characters`);
  expect(EXTRACTION_RULES).toContain('When in doubt, keep it');
  expect(EXTRACTION_RULES).toContain('Preserve useful commands');
});

it('keeps the prior handoff and failure count when every assigned card changes mid-run', async () => {
  await withDocumentStores(async (db) => {
    const run = await learningRun(db, plainTurns(2), 'low', undefined, 'the prior context');
    await run.readAll();
    const failures = (await db.prepare(`SELECT failures FROM learning_sessions WHERE session_id = 'long'`).first<{ failures: number }>())!.failures;
    expect(failures).toBeGreaterThan(0);
    await db.prepare(`UPDATE turn_cards SET input_hash = 'changed'`).run();
    expect(await run.complete('')).toEqual({ completed: true, covered: 0 });
    expect(await db.prepare(`SELECT handoff, failures FROM learning_sessions WHERE session_id = 'long'`).first()).toEqual({ handoff: 'the prior context', failures });
  });
});

it('holds one raw turn to an answer the harness keeps, and says how much it cut', async () => {
  await withDocumentStores(async (db) => {
    const key = uuid(600);
    const run = await learningRun(db, [longTurn(key, 'a turn longer than one answer', 10, 24)], 'high');
    const answer = await run.raw('myco_run_learning', { op: 'get', turn_key: key });
    expect(new TextEncoder().encode(JSON.stringify(answer.structuredContent)).length).toBeLessThanOrEqual(RUN_ANSWER_BYTES);
    expect((answer.structuredContent as { result: { raw: string } }).result.raw).toMatch(/\[… \d+ more characters\]$/);
  });
});

it('refuses a sourceless run an answer longer than its harness keeps, saying how to ask for less', async () => {
  await withDocumentStores(async (db) => {
    const run = await learningRun(db, plainTurns(1), 'low');
    await db.batch(Array.from({ length: 200 }, (_, at) => db.prepare(`INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES('project',?,'myco-agent',?,'gotcha',1)`).bind(`spr_${at}`, '増'.repeat(300))));
    expect(await run.call('myco_run_spores', { op: 'list', limit: 200 })).toMatchObject({ ok: false, code: 'answer_too_long', error: expect.stringContaining('smaller limit') });
    expect(await run.call('myco_run_spores', { op: 'list', limit: 20 })).toMatchObject({ total: 200 });
  });
});
