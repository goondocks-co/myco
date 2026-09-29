/**
 * The recall gold set (#1154) outside the parity run: the scoring and the
 * ratchet on inputs chosen to hit each rule, the fixture's own integrity, and
 * the committed baseline agreeing with the cases it records.
 *
 * The parity scenario (`tests/parity/scenarios/recall-gold.ts`) is what serves
 * the prompts through the shipped path on both front doors; this file holds
 * the pieces that decide what it concludes, so a scoring change is judged here
 * without a Worker boot.
 */
import { describe, expect, it } from 'bun:test';
import { EMBEDDING_TEXT_CHARS } from '@myco-server-worker/core/embedding/provider.js';
import { INJECTION_TARGET_ITEMS } from '@myco-server-worker/core/injection.js';
import { loadRecallFixture } from '../parity/recall/fixture.ts';
import { UnknownFixtureText } from '../parity/recall/lookup.ts';
import { compareToBaseline, describeComparison, scoreCase, summarize, withTarget, type GoldCase, type RecallBaseline } from '../parity/recall/score.ts';
import { caseCount, recallBaseline, recallQuality } from '@myco-server-worker/evals/recall-baseline.js';
import { RECALL_BASELINE_FILE, readRecallBaseline, renderRecallBaseline } from '../parity/recall/baseline-file.ts';
import { readFileSync } from 'node:fs';

const positive: GoldCase = { id: 'p', kind: 'positive', prompt: 'p', expected: ['a', 'b'], mustNot: ['x'] };
const negative: GoldCase = { id: 'n', kind: 'negative', prompt: 'n', expected: [], mustNot: [] };

describe('scoring one case', () => {
  it('passes a positive serving every expected spore and no must-not, and grades recall times precision over the whole block', () => {
    expect(scoreCase(positive, { spores: ['a', 'b'], plans: [] })).toEqual({ pass: true, graded: 1, expectedServed: ['a', 'b'], unwanted: [] });
    // A plan is a served item nobody expected: it costs precision and counts as unwanted, but only a must-not fails the pass.
    expect(scoreCase(positive, { spores: ['a', 'b'], plans: ['plan-1'] })).toEqual({ pass: true, graded: 2 / 3, expectedServed: ['a', 'b'], unwanted: ['plan-1'] });
    expect(scoreCase(positive, { spores: ['a', 'x', 'c'], plans: [] })).toEqual({ pass: false, graded: 0.5 * (1 / 3), expectedServed: ['a'], unwanted: ['x'] });
    expect(scoreCase(positive, { spores: [], plans: [] })).toEqual({ pass: false, graded: 0, expectedServed: [], unwanted: [] });
  });

  it('passes a negative, and scores it 1, only when nothing at all is injected', () => {
    expect(scoreCase(negative, { spores: [], plans: [] })).toMatchObject({ pass: true, graded: 1 });
    expect(scoreCase(negative, { spores: [], plans: ['plan-1'] })).toMatchObject({ pass: false, graded: 0, unwanted: ['plan-1'] });
    expect(scoreCase(negative, { spores: ['a'], plans: [] })).toMatchObject({ pass: false, graded: 0, unwanted: ['a'] });
  });
});

describe('the ratchet against a recorded baseline', () => {
  const gold = [positive, negative];
  const recorded = summarize(gold, { p: { spores: ['a', 'c'], plans: ['plan-1'] }, n: { spores: [], plans: ['plan-1'] } });

  it('records each case with its pass and graded score beside what it served', () => {
    expect(recorded.cases).toEqual({
      p: { spores: ['a', 'c'], plans: ['plan-1'], pass: false, graded: 0.1667 },
      n: { spores: [], plans: ['plan-1'], pass: false, graded: 0 },
    });
    expect({ recallQuality: recorded.recallQuality, passed: recorded.passed }).toEqual({ recallQuality: 0.0833, passed: 0 });
  });

  it('holds an unchanged release', () => {
    expect(compareToBaseline(gold, { p: { spores: ['a', 'c'], plans: ['plan-1'] }, n: { spores: [], plans: ['plan-1'] } }, recorded))
      .toEqual({ regressions: [], improvements: [], drift: [] });
  });

  it('fails a case that stops serving an expected spore it served at the baseline', () => {
    expect(compareToBaseline(gold, { p: { spores: ['c'], plans: ['plan-1'] }, n: { spores: [], plans: ['plan-1'] } }, recorded).regressions)
      .toEqual(['p: no longer serves expected a; graded score fell 0.1667 → 0.0000']);
  });

  it('fails a case that starts serving a must-not, more plans, or for a negative more spores', () => {
    expect(compareToBaseline(gold, { p: { spores: ['a', 'x'], plans: ['plan-1', 'plan-2'] }, n: { spores: ['c'], plans: ['plan-1'] } }, recorded).regressions)
      .toEqual(['p: now serves must-not x; now serves 2 plans (was 1); graded score fell 0.1667 → 0.1250', 'n: now serves 1 spore (was 0)']);
  });

  it('fails a negative whose plans give way to spores, though it serves as many items as before', () => {
    expect(compareToBaseline(gold, { p: { spores: ['a', 'c'], plans: ['plan-1'] }, n: { spores: ['c'], plans: [] } }, recorded).regressions)
      .toEqual(['n: now serves 1 spore (was 0)']);
  });

  it('reads one unnamed unwanted item swapped for another as a change, not a regression', () => {
    const swapped = compareToBaseline(gold, { p: { spores: ['a', 'c'], plans: ['plan-2'] }, n: { spores: [], plans: ['plan-3'] } }, recorded);
    expect({ regressions: swapped.regressions, drift: swapped.drift.map((d) => d.split(':')[0]) }).toEqual({ regressions: [], drift: ['p', 'n'] });
  });

  it('fails a positive whose graded score falls to an extra spore nobody listed, which no other axis names', () => {
    expect(compareToBaseline(gold, { p: { spores: ['a', 'c', 'd'], plans: ['plan-1'] }, n: { spores: [], plans: ['plan-1'] } }, recorded).regressions)
      .toEqual(['p: graded score fell 0.1667 → 0.1250']);
  });

  it('sets improvements and same-score changes apart, and fails both as a stale baseline in the gate', () => {
    const better = compareToBaseline(gold, { p: { spores: ['a', 'b'], plans: [] }, n: { spores: [], plans: ['plan-1'] } }, recorded);
    expect(better).toEqual({ regressions: [], improvements: ['p: graded score rose 0.1667 → 1.0000, now passes'], drift: [] });
    // A neutral spore swapped for another serves the same score: nothing better or worse, but not the recorded block.
    const swapped = compareToBaseline(gold, { p: { spores: ['a', 'd'], plans: ['plan-1'] }, n: { spores: [], plans: ['plan-1'] } }, recorded);
    expect({ regressions: swapped.regressions, improvements: swapped.improvements, drift: swapped.drift.map((d) => d.split(':')[0]) })
      .toEqual({ regressions: [], improvements: [], drift: ['p'] });
  });

  it('describes a comparison case by case, so a recording shows what it changes', () => {
    const text = describeComparison('self-hosted', compareToBaseline(gold, { p: { spores: ['c'], plans: ['plan-1'] }, n: { spores: [], plans: [] } }, recorded));
    expect(text.split('\n')).toEqual([
      'recall gold set, self-hosted: 1 regressed, 1 improved, 0 changed at the same score',
      '  regressed (1):',
      '    p: no longer serves expected a; graded score fell 0.1667 → 0.0000',
      '  improved (1):',
      '    n: graded score rose 0.0000 → 1.0000, now passes',
    ]);
  });

  it('takes the lower target as the headline, so a front door that serves worse is the one reported', () => {
    const one = withTarget(gold, null, 'self-hosted', { p: { spores: ['a', 'b'], plans: [] }, n: { spores: [], plans: [] } });
    const both = withTarget(gold, one, 'hosted', { p: { spores: ['a'], plans: [] }, n: { spores: [], plans: [] } });
    expect(Object.keys(both.targets)).toEqual(['hosted', 'self-hosted']);
    expect(both.recallQuality).toBe(both.targets.hosted!.recallQuality);
    expect(both.recallQuality).toBeLessThan(both.targets['self-hosted']!.recallQuality);
  });
});

describe('the recall fixture', () => {
  const { gold, corpus, index, lookup } = loadRecallFixture();
  const spores = new Set(corpus.spores.map((s) => s.id));

  it('holds the reviewed cases, every expected and must-not id a spore of the corpus', () => {
    expect(gold.cases.length).toBe(48);
    expect(gold.maxPerPrompt).toBe(INJECTION_TARGET_ITEMS);
    for (const c of gold.cases) {
      const unknown = [...c.expected, ...c.mustNot].filter((id) => !spores.has(id));
      expect({ id: c.id, unknown }).toEqual({ id: c.id, unknown: [] });
      if (c.kind === 'negative') expect({ id: c.id, expected: c.expected, mustNot: c.mustNot }).toEqual({ id: c.id, expected: [], mustNot: [] });
      else expect({ id: c.id, hasExpected: c.expected.length > 0 }).toEqual({ id: c.id, hasExpected: true });
    }
  });

  it('answers the exact text the server embeds for every spore, plan and prompt, and nothing else', async () => {
    const texts = [
      ...corpus.spores.map((s) => `${s.content}\n`),
      ...corpus.plans.map((p) => `${p.title ?? ''}\n${p.content}`),
      ...gold.cases.map((c) => c.prompt),
    ];
    expect(texts.length).toBe(index.rows.length);
    for (const text of texts) {
      // Under the cap, the provider sends the text unchanged, so the key is the text's own hash.
      expect(text.length).toBeLessThan(EMBEDDING_TEXT_CHARS);
      expect((await lookup.vectorFor(text)).length).toBe(index.dims);
    }
    await expect(lookup.vectorFor('a prompt nobody reviewed')).rejects.toBeInstanceOf(UnknownFixtureText);
  });
});

describe('the committed baseline', () => {
  const { gold } = loadRecallFixture();
  const baseline = recallBaseline as RecallBaseline;

  it('records both front doors over every case, and reports what those cases score', () => {
    expect(Object.keys(baseline.targets)).toEqual(['hosted', 'self-hosted']);
    expect(baseline.caseCount).toBe(gold.cases.length);
    for (const [name, target] of Object.entries(baseline.targets)) {
      // The summary is derived, never written by hand: recomputing it from the recorded blocks gives it back.
      const served = Object.fromEntries(Object.entries(target.cases).map(([id, c]) => [id, { spores: c.spores, plans: c.plans }]));
      expect({ name, summary: summarize(gold.cases, served) }).toEqual({ name, summary: target });
    }
    expect(baseline.recallQuality).toBe(Math.min(...Object.values(baseline.targets).map((t) => t.recallQuality)));
    // The constants the Measures page imports are the record's own headline.
    expect({ recallQuality, caseCount }).toEqual({ recallQuality: baseline.recallQuality, caseCount: baseline.caseCount });
  });

  it('reads back exactly as the recording writes it', () => {
    expect(readRecallBaseline()).toEqual(baseline);
    expect(renderRecallBaseline(readRecallBaseline()!)).toBe(readFileSync(RECALL_BASELINE_FILE, 'utf8'));
  });
});
