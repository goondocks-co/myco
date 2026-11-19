import { readAttention } from '@myco-server-worker/core/attention.js';
import { CURATION_PREVIEW_PAGES, discoverCurationPreview } from '@myco-server-worker/core/curation-preview.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { asOwnerPost, OWNER_ENV } from './helpers/owner.js';
import { expect, test } from 'bun:test';
import { curationFixture as fixture, keepAnswer, note, scope } from './helpers/curation.js';
import { discoverSporeClusters, CURATION_SEEDS_PER_TICK, CURATION_SEED_CAP, curationAssignment } from '@myco-server-worker/core/spore-curation.js';
import { CURATION_MATERIAL_BYTES } from '@myco-server-worker/core/spore-curation-contract.js';
import { expireLeases, endLeasedRun } from '@myco-server-worker/core/harness.js';
import { getRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { VECTOR_LOST_MS } from '@myco-server-worker/core/embedding/provider.js';
import { readCurationCoverage } from '@myco-server-worker/db/spores/curation-answer.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function claimed(f: Fixture, now = f.now) {
  const claim = await f.poll(now);
  if (!claim.claimed) throw new Error('group not claimed');
  const run = (await getRun(f.db, scope, claim.run.id))!;
  return { ...claim.run, members: curationAssignment(run.runContext)!.members.map(member => member.id) };
}
async function keep(f: Fixture, now = f.now) {
  const run = await claimed(f, now);
  expect(await f.call(run.runToken, 'myco_run_curation', keepAnswer(run.members))).toMatchObject({ completed: true });
  await endLeasedRun(f.env, { principal: f.principal, now: now + 1 }, { ...scope, runId: run.id, attemptId: run.attemptId, status: 'completed' });
  return run.members;
}

test('the mutual seed gate excludes a closer hub and typical noise while offering a strong pair', async () => {
  const f = await fixture();
  try {
    await f.enable();
    await f.add('a', [1, 0, 0]);
    await f.add('b', [0.84, Math.sqrt(1 - 0.84 ** 2), 0]);
    await f.add('noise', [0.7, -Math.sqrt(1 - 0.7 ** 2), 0]);
    await f.add('hub', [0.99, 0, Math.sqrt(1 - 0.99 ** 2)], f.now, 'Common to everything.', { mean: 0.01, std: 0.01 });
    await f.discover();
    expect(await keep(f)).toEqual(['a', 'b']);
    await f.discover(); expect(await f.poll()).toMatchObject({ claimed: false });
  } finally { f.sqlite.close(); }
});

test('missing calibration remains unevaluated until statistics arrive, and a settled walk rests', async () => {
  const f = await fixture();
  try {
    await f.enable(); await f.add('a', [1, 0], f.now, 'A', null); await f.add('b', [1, 0], f.now, 'B', null);
    await f.discover(); expect(await f.poll()).toMatchObject({ claimed: false });
    expect(await readCurationCoverage(f.db, 'proj_1')).toEqual({ unconsidered: 2, unevaluated: 2 });
    const visits = [...f.visits]; await f.discover(); expect(f.visits).toEqual(visits);
    await f.add('a'); await f.discover(); expect(await f.poll()).toMatchObject({ claimed: false });
    expect(await readCurationCoverage(f.db, 'proj_1')).toEqual({ unconsidered: 1, unevaluated: 1 });
    await f.add('b'); await f.discover(); expect((await keep(f)).sort()).toEqual(['a', 'b']);
    expect(await readCurationCoverage(f.db, 'proj_1')).toEqual({ unconsidered: 0, unevaluated: 0 });
    await f.discover(); const settled = [...f.visits]; await f.discover(); expect(f.visits).toEqual(settled);
  } finally { f.sqlite.close(); }
});

test('three interrupted attempts close a poison group and release seeds for a new overlap', async () => {
  const f = await fixture();
  try {
    await f.enable(); await f.add('a'); await f.add('b'); await f.discover();
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = f.now + attempt * 8 * 3_600_000, run = await claimed(f, now);
      f.sqlite.run('UPDATE agent_runs SET lease_expires_at=? WHERE id=?', [now + 1, run.id]);
      await expireLeases(f.env, now + 1);
      expect((await readAttention(f.env, now + 1)).items.filter(item => item.kind === 'outcome_failed')).toMatchObject(attempt < 2 ? [] : [{ task: 'curate-spores', runId: run.id }]);
      await discoverSporeClusters(f.env, now + 2);
    }
    expect(f.sqlite.query('SELECT decision,reason FROM spore_curation_work').get()).toEqual({ decision: 'failed', reason: 'Curation stopped after 3 attempts without a decision' });
    await f.add('c'); await f.discover();
    expect((await claimed(f, f.now + 16 * 3_600_000 + 3)).members.sort()).toEqual(['a', 'b', 'c']);
  } finally { f.sqlite.close(); }
});

test('whole material sheds its weakest non-anchor member and refuses an oversized anchor pair', async () => {
  const f = await fixture();
  try {
    await f.enable(); await f.add('a', [1, 0], f.now, 'a'.repeat(CURATION_MATERIAL_BYTES / 8));
    await f.add('b', [1, 0], f.now, 'b'.repeat(CURATION_MATERIAL_BYTES / 8));
    await f.add('high', [0.84, Math.sqrt(1 - 0.84 ** 2)], f.now, 'h'.repeat(CURATION_MATERIAL_BYTES / 4));
    await f.add('low', [0.76, Math.sqrt(1 - 0.76 ** 2)], f.now, 'l'.repeat(CURATION_MATERIAL_BYTES));
    await f.discover(); expect((await keep(f)).sort()).toEqual(['a', 'b', 'high']);
  } finally { f.sqlite.close(); }
  const g = await fixture();
  try {
    await g.enable(); for (const id of ['a', 'b']) await g.add(id, [1, 0], g.now, id.repeat(CURATION_MATERIAL_BYTES));
    await g.discover(); expect(await g.poll()).toMatchObject({ claimed: false });
    expect(g.sqlite.query('SELECT decision FROM spore_curation_work').get()).toEqual({ decision: 'oversized' });
  } finally { g.sqlite.close(); }
});

test('changes interrupt a history page, then resume it once without revisiting settled seeds', async () => {
  const f = await fixture();
  try {
    const older = Array.from({ length: 2 * CURATION_SEEDS_PER_TICK + 1 }, (_, i) => `old-${i}`);
    for (const [i, id] of older.entries()) await f.add(id, [1, 0], i + 1);
    f.env.vectors.query = async () => [];
    await f.enable(); await discoverSporeClusters(f.env, f.now);
    const before = [...f.visits]; await f.add('changed', [1, 0], f.now + 1);
    await discoverSporeClusters(f.env, f.now + 1);
    expect(f.visits.slice(before.length, before.length + 2)).toEqual(['changed', older[before.length]]);
    await f.discover(); expect(f.visits.filter(id => id.startsWith('old-'))).toEqual(older);
    const finished = [...f.visits]; await f.discover(); expect(f.visits).toEqual(finished);
  } finally { f.sqlite.close(); }
});

test('a capped group owns its members until its answer, leaving the next group disjoint', async () => {
  const f = await fixture();
  try {
    await f.enable(); for (let i = 0; i < 2 * CURATION_SEED_CAP; i++) await f.add(`s${String(i).padStart(2, '0')}`);
    await f.discover(); const first = await claimed(f);
    await f.discover(); expect(await f.poll()).toMatchObject({ claimed: false });
    expect(await f.call(first.runToken, 'myco_run_curation', keepAnswer(first.members))).toMatchObject({ completed: true });
    await endLeasedRun(f.env, { principal: f.principal, now: f.now + 1 }, { ...scope, runId: first.id, attemptId: first.attemptId, status: 'completed' });
    await f.discover(); const second = await keep(f);
    expect(first.members).toHaveLength(CURATION_SEED_CAP); expect(second).toHaveLength(CURATION_SEED_CAP);
    expect(second.filter(id => first.members.includes(id))).toEqual([]);
  } finally { f.sqlite.close(); }
});

test('a changed close releases its original seeds for a current assignment', async () => {
  const f = await fixture();
  try {
    await f.enable(); await f.add('a'); await f.add('b'); await f.discover();
    f.sqlite.run("UPDATE spores SET revision=revision+1,updated_at=? WHERE id='a'", [f.now + 1]);
    expect(await f.poll()).toMatchObject({ claimed: false });
    expect(f.sqlite.query('SELECT decision FROM spore_curation_work').get()).toEqual({ decision: 'changed' });
    await f.add('a'); await f.discover(); expect((await keep(f)).sort()).toEqual(['a', 'b']);
  } finally { f.sqlite.close(); }
});

test('pending vectors retry until visible, and a lost vector leaves readable unevaluated coverage', async () => {
  const f = await fixture(true);
  try {
    await f.enable(); await f.add('a'); f.applyVectors(); await f.discover();
    await f.add('b', [1, 0], f.now + 1); await discoverSporeClusters(f.env, f.now + 1);
    expect(await f.poll()).toMatchObject({ claimed: false });
    expect(await readCurationCoverage(f.db, 'proj_1')).toEqual({ unconsidered: 1, unevaluated: 1 });
    f.applyVectors(); await discoverSporeClusters(f.env, f.now + 60_000); expect((await keep(f, f.now + 60_000)).sort()).toEqual(['a', 'b']);
    await f.add('lost', [1, 0], f.now + 2); await discoverSporeClusters(f.env, f.now + VECTOR_LOST_MS);
    expect(await readCurationCoverage(f.db, 'proj_1')).toEqual({ unconsidered: 1, unevaluated: 1 });
    const visits = [...f.visits]; await discoverSporeClusters(f.env, f.now + VECTOR_LOST_MS + 60_000); expect(f.visits).toEqual(visits);
  } finally { f.sqlite.close(); }
});

test('daily allowance admits first attempts while an existing group may retry beyond that allowance', async () => {
  const f = await fixture();
  try {
    await f.enable(); await settingsWriter(f.db).setProjectLeaf('proj_1', 'agent.spore_curation.daily_runs', 1, 'test', f.now);
    await f.add('a'); await f.add('b'); await f.discover(); const run = await claimed(f);
    await endLeasedRun(f.env, { principal: f.principal, now: f.now + 1 }, { ...scope, runId: run.id, attemptId: run.attemptId, status: 'failed' });
    await f.add('c', [0, 1]); await f.add('d', [0, 1]); await f.discover();
    expect(await f.poll(f.now + 3)).toMatchObject({ claimed: false });
    expect((await keep(f, f.now + 8 * 3_600_000)).sort()).toEqual(['a', 'b']);
    expect(await f.poll(f.now + 8 * 3_600_000 + 2)).toMatchObject({ claimed: false });
    await settingsWriter(f.db).setProjectLeaf('proj_1', 'agent.spore_curation.daily_runs', 2, 'test', f.now);
    expect((await keep(f)).sort()).toEqual(['c', 'd']);
  } finally { f.sqlite.close(); }
});

test('applying an older split does not rewind the discovery frontier across unrelated seeds', async () => {
  const f = await fixture();
  try {
    await f.enable(); await f.add('c', [0.75, 0.6614, 0], 1);
    const seeds = Array.from({ length: CURATION_SEEDS_PER_TICK - 2 }, (_, i) => `x${i}`);
    for (const [i, id] of seeds.entries()) await f.add(id, [0, 0, 1], 10 + i, id, { mean: 0, std: 1 });
    await f.add('a', [1, 0, 0], 100); await f.add('b', [1, 0, 0], 101); await f.discover();
    const run = await claimed(f);
    expect(await f.call(run.runToken, 'myco_run_curation', { ...keepAnswer(['a', 'b']), notes: [note(['c'], 'Situation one.'), note(['c'], 'Situation two.')] })).toMatchObject({ completed: true });
    await endLeasedRun(f.env, { principal: f.principal, now: f.now + 1 }, { ...scope, runId: run.id, attemptId: run.attemptId, status: 'completed' });
    f.visits.length = 0; await f.discover(); expect(f.visits.filter(id => seeds.includes(id))).toEqual([]);
  } finally { f.sqlite.close(); }
});

test('preview discovery walks a fixed page budget, validates and resumes Project continuations without saving progress', async () => {
  const f = await fixture();
  try {
    const budget = CURATION_PREVIEW_PAGES * CURATION_SEEDS_PER_TICK;
    for (let i = 0; i < budget; i++) await f.add('noise-' + String(i).padStart(3, '0'), [0, 1], i + 1, 'Unrelated situation.', { mean: 0, std: 1 });
    await f.add('pair-a', [1, 0], budget + 1); await f.add('pair-b', [1, 0], budget + 2);
    const server = createServer({ now: () => f.now, sourceOf: () => '127.0.0.1', fetchImpl: fetch });
    const start = async (continuation?: unknown) => {
      const response = await server.handleRequest(await asOwnerPost(f.db, '/api/harness/dispatch', { task: 'curate-spores', projectId: 'proj_1', dryRun: true, continuation }), { ...f.env, secrets: OWNER_ENV });
      return { status: response.status, body: await response.json() as { outcome: string; continuation: { projectId: string } } };
    };
    const first = await start(); expect(first).toMatchObject({ status: 200, body: { outcome: 'no_qualifying_group', continuation: { projectId: 'proj_1' } } });
    expect(await start({ ...first.body.continuation, projectId: 'proj_2' })).toMatchObject({ status: 400, body: { error: 'invalid_curation_continuation' } });
    expect(await start({ version: 1 })).toMatchObject({ status: 400, body: { error: 'invalid_curation_continuation' } });
    expect(await start(first.body.continuation)).toMatchObject({ status: 200, body: { outcome: 'group_found', continuation: { projectId: 'proj_1' } } });
    const claim = await f.poll(); if (!claim.claimed) throw new Error('continued preview not claimed');
    expect(curationAssignment((await getRun(f.db, scope, claim.run.id))!.runContext)!.members.map(member => member.id)).toEqual(['pair-a', 'pair-b']);
  } finally { f.sqlite.close(); }
});

test('preview discovery names all-pending material and skips a pending seed when later seeds are ready', async () => {
  const f = await fixture(true);
  try {
    await f.add('pending', [0, 1], 1); await f.add('pair-a', [1, 0], 2); await f.add('pair-b', [1, 0], 3);
    expect(await discoverCurationPreview(f.env, { projectId: 'proj_1', now: f.now })).toMatchObject({ outcome: 'vectors_pending', input: null, continuation: null });
    f.applyVectors();
    const get = f.env.vectors.get.bind(f.env.vectors);
    f.env.vectors.get = async (...args) => (await get(...args)).filter(vector => vector.metadata.record_id !== 'pending');
    expect(await discoverCurationPreview(f.env, { projectId: 'proj_1', now: f.now })).toMatchObject({ outcome: 'group_found', input: { counts: { spores: 2 } } });
  } finally { f.sqlite.close(); }
});
