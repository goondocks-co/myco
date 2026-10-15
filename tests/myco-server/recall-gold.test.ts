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
import { INJECTION_TARGET_ITEMS, selectSporesForPrompt } from '@myco-server-worker/core/injection.js';
import { loadRecallFixture, seedStatements } from '../parity/recall/fixture.ts';
import { UnknownFixtureText } from '../parity/recall/lookup.ts';
import { compareToBaseline, describeComparison, mustNotRegressions, scoreCase, summarize, summarizeMustNot, withTarget, type GoldCase, type RecallBaseline } from '../parity/recall/score.ts';
import { caseCount, recallBaseline, recallQuality } from '@myco-server-worker/evals/recall-baseline.js';
import { RECALL_BASELINE_FILE, readRecallBaseline, renderRecallBaseline } from '../parity/recall/baseline-file.ts';
import { readFileSync } from 'node:fs';
import { distributionStats, selectRelevantPlans } from '../../packages/myco-shared/src/relevance.ts';
import { cosineSimilarity, vectorId, vectorMatches, type StoredVector } from '@myco-server-worker/core/embedding/vectors.js';
import { Database } from 'bun:sqlite';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import type { EmbeddingSource, SemanticSearch } from '@myco-server-worker/read/embedding.js';

describe('model-relative prompt selection on frozen gold geometry', () => {
  const { gold, corpus, index, data } = loadRecallFixture();
  const floats = new Float32Array(data);
  const original = new Map(index.rows.map(r => [r.id, Array.from(floats.slice(r.row * index.dims, (r.row + 1) * index.dims))]));
  const sporeStats = new Map(corpus.spores.map(s => [s.id, distributionStats(corpus.spores.filter(p => p.id !== s.id)
    .map(p => 1 - cosineSimilarity(original.get(s.id)!, original.get(p.id)!)))]));
  const scope = { projectId: 'affine-gold' };

  async function measure(a: number, b: number, sporeLimit = 100) {
    // Shared and row-private orthogonal coordinates realize a + b*cosine for every distinct pair.
    const geometry = new Map(index.rows.map(r => {
      const v = original.get(r.id)!;
      const magnitude = Math.hypot(...v);
      const transformed = [...v.map(x => Math.sqrt(b) * x / magnitude), Math.sqrt(a), ...index.rows.map(() => 0)];
      transformed[index.dims + 1 + r.row] = Math.sqrt(1 - a - b);
      return [r.id, transformed] as const;
    }));
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec('PRAGMA foreign_keys = ON');
      for (const migration of renderMigrationFiles()) sqlite.exec(migration.sql);
      sqlite.query('INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, 0)').run(scope.projectId, 'Affine gold');
      sqlite.exec("INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('affine', 'affine', 'built-in', 1, 0)");
      for (const statement of seedStatements(scope.projectId, corpus, 'affine', 0)) sqlite.exec(statement);
      const db = sqliteRelationalStore(sqlite);
      const partition = { ...scope, modelKey: `affine-${a}-${b}` };
      const sources = (await db.prepare("SELECT * FROM embedding_sources WHERE project_id = ? AND type IN ('spore', 'plan')")
        .bind(scope.projectId).all<EmbeddingSource>()).results;
      const vectors: StoredVector[] = await Promise.all(sources.map(async source => {
        const id = await vectorId(partition, source.type, source.record_id, source.revision);
        const stats = sporeStats.get(source.record_id);
        await db.prepare(`INSERT INTO embedding_receipts(project_id, model_key, id, type, record_id, revision, ready, updated_at, neighbor_mean, neighbor_std)
          VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`).bind(scope.projectId, partition.modelKey, id, source.type, source.record_id, source.revision,
          stats === undefined ? null : 1 - a - b + b * stats.mean, stats === undefined ? null : b * stats.std).run();
        return { id, values: geometry.get(source.record_id)!, metadata: source };
      }));
      const semantic: SemanticSearch = {
        provider: { modelKey: partition.modelKey, embed: async text => geometry.get(gold.cases.find(c => c.prompt === text)!.id)! },
        vectors: {
          query: async (asked, options) => {
            expect(asked).toEqual(partition);
            return vectors.filter(v => vectorMatches(v.metadata, options.filters))
              .map(v => ({ id: v.id, score: cosineSimilarity(options.values, v.values) }))
              .sort((x, y) => y.score - x.score).slice(0, options.filters?.type === 'spore' ? Math.min(sporeLimit, options.topK) : options.topK);
          },
          get: async (asked, ids) => { expect(asked).toEqual(partition); return vectors.filter(v => ids.includes(v.id)); },
          upsert: async () => { throw new Error('read-only gold vectors'); },
          delete: async () => { throw new Error('read-only gold vectors'); },
        },
      };
      const answers = [];
      for (const c of gold.cases) {
        const answer = await selectSporesForPrompt(db, scope, { enabled: true, maxPerPrompt: 7 }, true,
          { sessionId: c.id, promptId: c.id, promptHash: c.id, prompt: c.prompt, now: 1 }, async () => semantic);
        answers.push({ id: c.id, items: answer.items.map(i => ({ id: i.id, kind: i.kind })), counts: answer.counts });
      }
      return answers;
    } finally { sqlite.close(); }
  }

  it('holds measured gold blocks to the recorded precision and recall ratchet', async () => {
    const answers = await measure(0, 1);
    const served = Object.fromEntries(answers.map(a => [a.id, {
      spores: a.items.filter(i => i.kind === 'spore').map(i => i.id),
      plans: a.items.filter(i => i.kind === 'plan').map(i => i.id),
    }]));
    for (const target of Object.values(recallBaseline.targets)) {
      const comparison = compareToBaseline(gold.cases, served, target);
      expect(comparison).toEqual({ regressions: [], improvements: [], drift: [] });
    }
    expect(mustNotRegressions(gold.cases, served, gold.precisionRatchet)).toEqual([]);
  }, 30_000);

  it('keeps served spores and plans identical under affine similarity changes', async () => {
    const baseline = await measure(0, 1);
    expect(baseline.find(a => a.id === 'rp-43')!.items.filter(i => i.kind === 'plan').map(i => i.id))
      .toEqual(['a3b1e332-96a2-56e0-9afa-01876916c3a3']);
    expect(baseline.some(a => a.items.some(i => i.kind === 'spore'))).toBe(true);
    for (const [a, b] of [[0.3, 0.5], [0, 0.5], [0.6, 0.39], [0.05, 0.3]] as const) {
      const transformed = await measure(a, b);
      expect(transformed.map(({ id, items }) => ({ id, items }))).toEqual(baseline.map(({ id, items }) => ({ id, items })));
    }
  }, 30_000);

  it.each([0, 1, 4])('withholds real-vector plans and spores with only %s independent spore candidates', async size => {
    const answers = await measure(0, 1, size);
    expect(answers.every(a => a.items.length === 0)).toBe(true);
    expect(answers.every(a => a.counts.planCalibration === 'insufficient' && a.counts.planQueryCandidates === size)).toBe(true);
    expect(answers.every(a => a.counts.planCalibrated === corpus.plans.length)).toBe(true);
    expect(answers.every(a => a.counts.sporeCalibrated === size && a.counts.sporeScored === 0
      && a.counts.sporeProbable === 0 && a.counts.sporeSeparated === 0)).toBe(true);
  }, 30_000);
});

const positive: GoldCase = { id: 'p', kind: 'positive', prompt: 'p', expected: ['a', 'b'], mustNot: ['x'] };
const negative: GoldCase = { id: 'n', kind: 'negative', prompt: 'n', expected: [], mustNot: [] };

describe('must-not precision ratchet', () => {
  const gold = [positive, { ...positive, id: 'q', mustNot: ['y'] }];
  const ceiling = { matches: 1, caseIds: ['p'] };
  it('allows fewer matches and fewer affected cases', () => {
    const served = { p: { spores: ['a'], plans: [] }, q: { spores: ['a'], plans: [] } };
    expect(summarizeMustNot(gold, served)).toEqual({ matches: 0, caseIds: [] });
    expect(mustNotRegressions(gold, served, ceiling)).toEqual([]);
  });
  it('rejects an added match even within an already affected case', () => {
    const expanded = [{ ...positive, mustNot: ['x', 'z'] }, gold[1]!];
    expect(mustNotRegressions(expanded, { p: { spores: ['x', 'z'], plans: [] }, q: { spores: [], plans: [] } }, ceiling))
      .toEqual(['must-not matches rose 1 → 2']);
  });
  it('rejects a new affected case even when total matches stay unchanged', () => {
    expect(mustNotRegressions(gold, { p: { spores: [], plans: [] }, q: { spores: ['y'], plans: [] } }, ceiling))
      .toEqual(['new must-not cases: q']);
  });
});

describe('scoring one case', () => {
  it('credits expected plans and penalizes unexpected plans', () => {
    const planCase = { ...positive, expectedPlans: ['live'] };
    expect(scoreCase(planCase, { spores: ['a', 'b'], plans: ['live'] })).toMatchObject({ pass: true, graded: 1, unwanted: [] });
    expect(scoreCase(planCase, { spores: ['a', 'b'], plans: ['live', 'other'] })).toMatchObject({ pass: true, graded: 0.75, unwanted: ['other'] });
    expect(scoreCase(planCase, { spores: ['a', 'b'], plans: [] })).toMatchObject({ pass: false, expectedServed: ['a', 'b'] });
  });
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

  it('serves the delivery-reset plan for real rp-43 vectors despite tighter plan-to-plan geometry', () => {
    const { data } = loadRecallFixture();
    const floats = new Float32Array(data);
    const vectors = new Map(index.rows.map(r => [r.id, Array.from(floats.slice(r.row * index.dims, (r.row + 1) * index.dims))]));
    const query = vectors.get('rp-43')!;
    const plans = corpus.plans.map(p => {
      const stats = distributionStats(corpus.plans.filter(other => other.planKey !== p.planKey)
        .map(other => 1 - cosineSimilarity(vectors.get(p.planKey)!, vectors.get(other.planKey)!)));
      return { id: p.planKey, similarity: cosineSimilarity(query, vectors.get(p.planKey)!), neighborMean: stats.mean, neighborStd: stats.std,
        alreadyInjected: p.status !== 'active' && p.status !== 'in_progress' };
    });
    const spores = corpus.spores.map(s => ({ id: s.id, similarity: cosineSimilarity(query, vectors.get(s.id)!) }))
      .sort((a, b) => b.similarity - a.similarity).slice(0, 100);
    const expected = 'a3b1e332-96a2-56e0-9afa-01876916c3a3';
    const plan = plans.find(p => p.id === expected)!;
    expect(1 - plan.neighborMean).toBeGreaterThan(plan.similarity);
    const selected = selectRelevantPlans(plans, { maxResults: 2, referenceCandidates: plans, sporeCandidates: spores });
    expect(selected.map(p => p.id)).toEqual([expected]);
    expect(selected[0]!.mp).toBeGreaterThan(0.75);
    expect(selected[0]!.mp).toBeLessThan(0.9);
  });

  it('holds the reviewed cases, every expected and must-not id a spore of the corpus', () => {
    expect(gold.cases.length).toBe(48);
    expect(gold.maxPerPrompt).toBe(INJECTION_TARGET_ITEMS);
    for (const c of gold.cases) {
      const unknown = [...c.expected, ...c.mustNot].filter((id) => !spores.has(id));
      expect({ id: c.id, unknown }).toEqual({ id: c.id, unknown: [] });
      expect((c.expectedPlans ?? []).every(id => corpus.plans.some(p => p.planKey === id && (p.status === 'active' || p.status === 'in_progress')))).toBe(true);
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

  it('holds the approved must-not count and case identities on both doors', () => {
    expect(gold.precisionRatchet.matches).toBe(13);
    for (const target of Object.values(baseline.targets)) {
      expect(mustNotRegressions(gold.cases, target.cases, gold.precisionRatchet)).toEqual([]);
      expect(target.mustNot).toEqual(summarizeMustNot(gold.cases, target.cases));
    }
  });

  it('rejects one additional must-not match in a recorded gold block', () => {
    for (const target of Object.values(baseline.targets)) {
      const changed = structuredClone(target.cases);
      const c = gold.cases.find(c => target.mustNot.caseIds.includes(c.id)
        && c.mustNot.some(id => !changed[c.id]!.spores.includes(id)))!;
      changed[c.id]!.spores.push(c.mustNot.find(id => !changed[c.id]!.spores.includes(id))!);
      expect(mustNotRegressions(gold.cases, changed, target.mustNot))
        .toEqual([`must-not matches rose ${target.mustNot.matches} → ${target.mustNot.matches + 1}`]);
    }
  });

  it('rejects moving a recorded must-not match to a new gold case', () => {
    for (const target of Object.values(baseline.targets)) {
      const changed = structuredClone(target.cases);
      const removed = gold.cases.find(c => c.mustNot.some(id => changed[c.id]!.spores.includes(id)))!;
      const id = removed.mustNot.find(id => changed[removed.id]!.spores.includes(id))!;
      changed[removed.id]!.spores = changed[removed.id]!.spores.filter(served => served !== id);
      const added = gold.cases.find(c => !target.mustNot.caseIds.includes(c.id) && c.mustNot.length > 0)!;
      changed[added.id]!.spores.push(added.mustNot[0]!);
      expect(summarizeMustNot(gold.cases, changed).matches).toBe(target.mustNot.matches);
      expect(mustNotRegressions(gold.cases, changed, target.mustNot)).toEqual([`new must-not cases: ${added.id}`]);
    }
  });

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
