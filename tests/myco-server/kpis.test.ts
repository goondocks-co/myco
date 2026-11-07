/**
 * The six measures: each computed from rows a Deployment holds, each carrying the
 * sample it stands on.
 *
 * Every assertion here drives the reader against a migrated store with rows
 * written through plain SQL, so a measure is judged on what the tables hold rather
 * than on what a fixture claims. The shape that matters most is the empty one: a
 * measure with no rows answers a null value and a zero sample, which is what lets
 * the surface say there is no sample instead of printing a figure.
 */
import { statementRecorder } from '../helpers/statement-recorder.js';
import { describe, expect, it } from 'bun:test';
import { kpiWindow, median, readKpis, KPI_WINDOWS, type KpiWindow } from '@myco-server-worker/read/kpis.js';
import { recallQuality, caseCount } from '@myco-server-worker/evals/recall-baseline.js';

import { rig, NOW, DAY, PROJECT, OTHER } from './helpers/kpi-fixture.js';

const baseline = { recallQuality, caseCount };

const readyKpis = async (db: ReturnType<typeof rig>['db'], opts: { window: KpiWindow; now: number }) => {
  const answer = await readKpis(db, opts);
  expect(answer.state).toBe('ready');
  if (answer.state !== 'ready') throw new Error('KPI projection is building');
  return answer;
};

const all = (db: ReturnType<typeof rig>['db']) => readyKpis(db, { window: null, now: NOW });

describe('the measures', () => {
  it('answers every measure with a null value and an empty sample on a Deployment holding nothing', async () => {
    const report = await all(rig().db);
    expect({
      servedShare: report.servedShare,
      sporeServeRate: report.sporeServeRate,
      callsPerPrompt: report.callsPerPrompt,
      planReadsPerSession: report.planReadsPerSession,
      firstInjectionMs: report.firstInjectionMs,
      byHarness: report.callsPerPromptByHarness,
    }).toEqual({
      servedShare: { value: null, sampleSize: 0 },
      sporeServeRate: { value: null, sampleSize: 0 },
      callsPerPrompt: { value: null, sampleSize: 0 },
      planReadsPerSession: { value: null, sampleSize: 0 },
      firstInjectionMs: { value: null, sampleSize: 0 },
      byHarness: [],
    });
  });

  it('counts a session start block over the sessions it reached, and credits it to no prompt', async () => {
    const r = rig();
    r.session('s1');
    r.prompt('p1', 's1', { at: NOW + 1 });
    r.prompt('p2', 's1', { at: NOW + 2 });
    r.prompt('p3', 's1', { at: NOW + 3 });
    r.prompt('p4', 's1', { at: NOW + 4 });
    // A session start block is the session's: it reaches the session, not a prompt of it.
    r.sessionInjection('s1', 'cortex', { at: NOW });
    r.session('s2');
    const report = await all(r.db);
    expect(report.servedShare).toEqual({ value: 0, sampleSize: 4 });
    expect(report.sessionStartPresent).toEqual({ value: 0.5, sampleSize: 2 });
  });

  it('counts a prompt served an observation on its own, beside the one the session record reached', async () => {
    const r = rig();
    r.session('s1');
    r.prompt('p1', 's1', { at: NOW + 1 });
    r.prompt('p2', 's1', { at: NOW + 2 });
    r.prompt('p3', 's1', { at: NOW + 3 });
    r.prompt('p4', 's1', { at: NOW + 4 });
    r.sessionInjection('s1', 'cortex', { at: NOW });
    // p3 receives spores of its own, so one of the four prompts got something.
    r.sporeInjection('s1', 'p3', ['sp1']);
    const report = await all(r.db);
    expect(report.servedShare).toEqual({ value: 0.25, sampleSize: 4 });
    expect(report.sporeServeRate).toEqual({ value: 0.25, sampleSize: 4 });
  });

  it('credits the prompt a receipt was delivered to, never the one whose text selected it, and none for a receipt never delivered', async () => {
    const r = rig();
    r.session('s1');
    r.prompt('p1', 's1', { at: NOW - 10_000 });
    r.prompt('p2', 's1', { at: NOW });
    r.prompt('p3', 's1', { at: NOW + 1 });
    r.sporeInjection('s1', 'p1', ['sp1'], { deliveredTo: 'p2' });
    r.sporeInjection('s1', 'p3', ['sp2'], { deliveredTo: null });
    const report = await all(r.db);
    expect(report.servedShare).toEqual({ value: 1 / 3, sampleSize: 3 });
    expect(report.sporeServeRate).toEqual({ value: 1 / 3, sampleSize: 3 });
  });

  it('reads a record naming no spore as context served and as a measured zero, not an absent sample', async () => {
    const r = rig();
    r.session('s1');
    r.prompt('p1', 's1');
    r.sporeInjection('s1', 'p1', []);
    const report = await all(r.db);
    // A share of zero over one prompt is a measurement. Only an empty sample has no value.
    expect({ context: report.servedShare, spores: report.sporeServeRate })
      .toEqual({ context: { value: 1, sampleSize: 1 }, spores: { value: 0, sampleSize: 1 } });
  });

  it('never credits one Project\'s record to another Project\'s prompt', async () => {
    const r = rig();
    r.session('s1');
    r.session('s1', { project: OTHER });
    r.prompt('p1', 's1');
    r.prompt('p1', 's1', { project: OTHER });
    r.sporeInjection('s1', 'p1', ['sp1']);
    const report = await all(r.db);
    expect(report.sporeServeRate).toEqual({ value: 0.5, sampleSize: 2 });
  });

  it('separates prompts served from receipts delivered in the window and recomputes placement when a hint arrives', async () => {
    const r = rig();
    r.session('s1');
    r.session('s2');
    r.session('s1', { project: OTHER });
    r.prompt('p1', 's1');
    r.prompt('p2', 's1');
    r.prompt('elsewhere', 's2');
    r.prompt('foreign', 's1', { project: OTHER });
    r.prompt('old', 's1', { at: NOW - 30 * DAY });
    r.sporeInjection('s1', 'previous-selection', [], { at: NOW - 30 * DAY, deliveredTo: 'p1', deliveredAt: NOW });
    r.sporeInjection('s1', 'repeated-selection', [], { deliveredTo: 'p1' });
    r.sporeInjection('s1', 'old-prompt-selection', [], { deliveredTo: 'old' });
    r.sporeInjection('s1', 'wrong-session-selection', [], { deliveredTo: 'elsewhere' });
    r.sporeInjection('s1', 'wrong-project-selection', [], { deliveredTo: 'foreign' });
    r.sporeInjection('s1', 'no-hint-selection', [], { deliveredTo: null, deliveredAt: NOW });
    r.sporeInjection('s1', 'awaiting-transcript', [], { deliveredTo: 'later' });
    r.sporeInjection('s1', 'p2', [], { deliveredTo: null });
    r.sporeInjection('s1', 'older-delivery-selection', [], { deliveredTo: 'p2', at: NOW - 30 * DAY });
    const read = () => readyKpis(r.db, { window: 7, now: NOW });
    const before = await read();
    expect(before.promptsServed).toBe(2);
    expect(before.servedShare).toEqual({ value: 0.5, sampleSize: 4 });
    expect(before.deliveries).toEqual({ placed: 3, unplaced: 4 });
    r.prompt('later', 's1');
    const after = await read();
    expect(after.promptsServed).toBe(3);
    expect(after.servedShare).toEqual({ value: 3 / 5, sampleSize: 5 });
    expect(after.deliveries).toEqual({ placed: 4, unplaced: 3 });
  });

  it('counts Myco calls per prompt and splits them by the agent the session ran under, naming a session with no transcript', async () => {
    const r = rig();
    r.session('s1', { agent: 'claude-code' });
    r.session('s2', { agent: 'codex' });
    r.session('s3', { agent: null });
    r.prompt('p1', 's1');
    r.prompt('p2', 's1');
    r.prompt('p3', 's2');
    r.prompt('p4', 's3');
    r.call('c1', 's1');
    r.call('c2', 's1');
    r.call('c3', 's1');
    r.call('c4', 's2');
    // A tool call that never reached Myco is not a Myco call.
    r.call('c5', 's2', { tool: null });
    const report = await all(r.db);
    expect(report.callsPerPrompt).toEqual({ value: 1, sampleSize: 4 });
    expect(report.callsPerPromptByHarness).toEqual([
      { harness: 'claude-code', value: 1.5, sampleSize: 2, calls: 3 },
      { harness: 'codex', value: 1, sampleSize: 1, calls: 1 },
      { harness: 'unrecorded', value: 0, sampleSize: 1, calls: 0 },
    ]);
  });

  it('gives a harness whose calls landed in the window but whose prompts did not an empty sample rather than leaving it out', async () => {
    const r = rig();
    r.session('recent', { agent: 'claude-code', at: NOW - DAY });
    r.session('old', { agent: 'codex', at: NOW - 60 * DAY });
    r.prompt('p_recent', 'recent', { at: NOW - DAY });
    r.prompt('p_old', 'old', { at: NOW - 60 * DAY });
    r.call('c1', 'recent', { at: NOW - DAY });
    // A codex call inside the window whose prompt sits outside it. The call is
    // counted in the whole, so the split accounts for it rather than dropping it.
    r.call('c2', 'old', { at: NOW - DAY });
    const week = await readyKpis(r.db, { window: 7, now: NOW });
    expect(week.callsPerPrompt).toEqual({ value: 2, sampleSize: 1 });
    // The call counts add up to the whole above them: 1 + 1 = 2.
    expect(week.callsPerPromptByHarness).toEqual([
      { harness: 'claude-code', value: 1, sampleSize: 1, calls: 1 },
      { harness: 'codex', value: null, sampleSize: 0, calls: 1 },
    ]);
    expect(week.callsPerPromptByHarness.reduce((n, r) => n + r.calls, 0)).toBe(2);
  });

  it('counts plan reads per session and leaves every plan write out of the count', async () => {
    const r = rig();
    r.session('s1');
    r.session('s2');
    r.call('c1', 's1', { tool: 'myco_plans', op: 'list' });
    r.call('c2', 's1', { tool: 'myco_plans', op: 'get' });
    // The absent op is the tool's own default, which is `list`.
    r.call('c3', 's1', { tool: 'myco_plans', op: null });
    r.call('c4', 's1', { tool: 'myco_plans', op: 'save' });
    // A deletion is a write. An op the allow-list does not name is never a read.
    r.call('c5', 's1', { tool: 'myco_plans', op: 'delete' });
    r.call('c6', 's1', { tool: 'myco_plans', op: 'some_op_added_later' });
    r.call('c7', 's2', { tool: 'myco_search', op: 'search' });
    const report = await all(r.db);
    expect(report.planReadsPerSession).toEqual({ value: 1.5, sampleSize: 2 });
  });

  it('measures the wait to a first served context per credential lineage, taking the middle of the samples', async () => {
    const r = rig();
    // Two credentials of one lineage: the refresh does not read as a second install.
    r.credential('cred_1', { lineage: 'lin_1', startedAt: NOW - 10 * DAY });
    r.credential('cred_1b', { lineage: 'lin_1', startedAt: NOW - 2 * DAY });
    r.credential('cred_2', { lineage: 'lin_2', startedAt: NOW - 5 * DAY });
    r.credential('cred_3', { lineage: 'lin_3', startedAt: NOW - DAY });
    r.session('s1', { tokenId: 'cred_1' });
    r.session('s1b', { tokenId: 'cred_1b' });
    r.session('s2', { tokenId: 'cred_2' });
    r.session('s3', { tokenId: 'cred_3' });
    r.sessionInjection('s1', 'cortex', { at: NOW - 10 * DAY + 60_000 });
    r.sporeInjection('s1b', 'pX', ['sp1'], { at: NOW - DAY });
    r.sessionInjection('s2', 'cortex', { at: NOW - 5 * DAY + 20_000 });
    const recorded = statementRecorder(r.db, { accounting: 'native' });
    const report = await readyKpis(recorded.db, { window: 30, now: NOW });
    expect(report.firstInjectionMs).toEqual({ value: 40_000, sampleSize: 2 });
    expect(recorded.statements.map(statement => statement.method)).toEqual(['batch', 'batch', 'batch']);
    expect((await all(r.db)).firstInjectionMs).toEqual(report.firstInjectionMs);
    r.sqlite.close();
  });

  it('counts only rows inside the window a caller asked for', async () => {
    const r = rig();
    r.session('recent', { at: NOW - DAY });
    r.session('old', { at: NOW - 60 * DAY });
    r.prompt('p_recent', 'recent', { at: NOW - DAY });
    r.prompt('p_old', 'old', { at: NOW - 60 * DAY });
    r.sporeInjection('recent', 'p_recent', ['sp1'], { at: NOW - DAY });
    const week = await readyKpis(r.db, { window: 7, now: NOW });
    const everything = await all(r.db);
    expect({ week: week.sporeServeRate, all: everything.sporeServeRate, weekSessions: week.planReadsPerSession.sampleSize })
      .toEqual({ week: { value: 1, sampleSize: 1 }, all: { value: 0.5, sampleSize: 2 }, weekSessions: 1 });
    expect({ windowDays: week.windowDays, since: week.since }).toEqual({ windowDays: 7, since: (Math.floor(NOW / DAY) - 7) * DAY });
  });

  it('uses N complete UTC days plus today, with exact day and lineage bounds', async () => {
    for (const window of [...KPI_WINDOWS, null]) {
      const r = rig();
      try {
        const today = Math.floor(NOW / DAY);
        const start = window === null ? (today - 1000) * DAY : (today - window) * DAY;
        const end = (today + 1) * DAY - 1;
        for (const [id, at] of [['before', start - 1], ['start', start], ['end', end], ['after', end + 1]] as const) {
          r.credential(id, { startedAt: at });
          r.session(id, { at, tokenId: id, agent: null });
          r.prompt(id, id, { at });
          r.call(id, id, { at, tool: 'myco_plans', op: 'get' });
          r.sporeInjection(id, id, ['spore'], { at });
        }
        const report = await readyKpis(r.db, { window, now: NOW });
        expect(report).toMatchObject({
          state: 'ready', windowDays: window, since: window === null ? null : start,
          windowStart: window === null ? null : start, windowEnd: end, asOf: NOW,
        });
        const count = window === null ? 3 : 2;
        expect(report.servedShare).toEqual({ value: 1, sampleSize: count });
        expect(report.callsPerPrompt).toEqual({ value: 1, sampleSize: count });
        expect(report.planReadsPerSession).toEqual({ value: 1, sampleSize: count });
        expect(report.deliveries).toEqual({ placed: count, unplaced: 0 });
        expect(report.firstInjectionMs).toEqual({ value: 0, sampleSize: count });
      } finally { r.sqlite.close(); }
    }
  });

  it('reports the recall quality this release recorded, whatever the Deployment holds or the window asked', async () => {
    const r = rig();
    r.session('s1');
    r.prompt('p1', 's1');
    const recorded = { value: baseline.recallQuality, sampleSize: baseline.caseCount };
    expect((await all(r.db)).recallQuality).toEqual(recorded);
    expect((await all(rig().db)).recallQuality).toEqual(recorded);
    expect((await readyKpis(r.db, { window: 7, now: NOW })).recallQuality).toEqual(recorded);
    expect(baseline.caseCount).toBeGreaterThan(0);
  });
});

describe('the window a caller may ask for', () => {
  it('admits only the offered windows', () => {
    expect(KPI_WINDOWS.map((d) => kpiWindow(String(d)))).toEqual([...KPI_WINDOWS]);
    expect([kpiWindow(null), kpiWindow('all'), kpiWindow('5'), kpiWindow('nonsense'), kpiWindow('-7')])
      .toEqual([null, null, undefined, undefined, undefined]);
  });
});

describe('the middle of a sample', () => {
  it('takes the middle of an odd set and the mean of the two middles of an even one, and has no answer for an empty one', () => {
    expect([median([]), median([5]), median([1, 3, 5]), median([1, 3, 5, 9])]).toEqual([null, 5, 3, 4]);
  });
});
