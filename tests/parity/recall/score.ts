/**
 * Scoring the recall gold set, and holding a release to its recorded baseline.
 *
 * A case is one real prompt and what its injected block should carry. The
 * block is scored whole — spores and plans — because the whole block is what
 * an agent reads.
 *
 * - A **positive** case passes when every expected spore is served and no
 *   must-not spore is. Its graded score is the share of expected spores served
 *   times the share of served items that were expected (plans count as served
 *   items; none is ever expected).
 * - A **negative** case passes, and scores 1, only when nothing is injected.
 *
 * The release gate is a per-case ratchet against the baseline recorded for
 * the same target. A case regresses when it stops serving an expected spore it
 * served at the baseline, when it starts serving a must-not spore it did not,
 * when it serves more plans than it did (a negative, also more spores), or
 * when its graded score falls (an extra spore nobody listed still
 * dilutes the block). Any other change leaves the baseline describing a release
 * that no longer exists, so it fails too and asks for the baseline to be
 * recorded again: the committed baseline is always what this code serves,
 * which is what the Recall quality measure reports. Recording compares first,
 * and refuses to write a regression unless it is accepted by name.
 */
export interface GoldCase {
  id: string;
  kind: 'positive' | 'negative';
  prompt: string;
  expected: string[];
  mustNot: string[];
}

export interface Served {
  spores: string[];
  plans: string[];
}

export interface CaseScore {
  pass: boolean;
  graded: number;
  expectedServed: string[];
  unwanted: string[];
}

export function scoreCase(gold: GoldCase, served: Served): CaseScore {
  const total = served.spores.length + served.plans.length;
  if (gold.kind === 'negative') {
    return { pass: total === 0, graded: total === 0 ? 1 : 0, expectedServed: [], unwanted: [...served.spores, ...served.plans] };
  }
  const expectedServed = gold.expected.filter((id) => served.spores.includes(id));
  const unwanted = [...served.spores.filter((id) => gold.mustNot.includes(id)), ...served.plans];
  const recall = gold.expected.length === 0 ? 0 : expectedServed.length / gold.expected.length;
  const precision = total === 0 ? 0 : expectedServed.length / total;
  const pass = expectedServed.length === gold.expected.length && !served.spores.some((id) => gold.mustNot.includes(id));
  return { pass, graded: recall * precision, expectedServed, unwanted };
}

/** One case as recorded: what it served, and what that scores, so a baseline diff shows each case moving. */
export interface RecordedCase extends Served {
  pass: boolean;
  graded: number;
}

export interface TargetBaseline {
  /** The mean graded score over every case. */
  recallQuality: number;
  passed: number;
  cases: Record<string, RecordedCase>;
}

export interface RecallBaseline {
  version: 1;
  caseCount: number;
  /** The lower of the front doors' means: the figure the Recall quality measure shows. */
  recallQuality: number;
  targets: Record<string, TargetBaseline>;
}

/** A target's record, every figure derived from what each case served. */
export function summarize(gold: readonly GoldCase[], cases: Record<string, Served>): TargetBaseline {
  const recorded: Record<string, RecordedCase> = {};
  for (const g of gold) {
    const served = cases[g.id];
    if (served === undefined) throw new Error(`no served block recorded for ${g.id}`);
    const score = scoreCase(g, served);
    recorded[g.id] = { spores: served.spores, plans: served.plans, pass: score.pass, graded: round(score.graded) };
  }
  const all = Object.values(recorded);
  return {
    recallQuality: round(all.reduce((sum, c) => sum + c.graded, 0) / all.length),
    passed: all.filter((c) => c.pass).length,
    cases: recorded,
  };
}

/** The baseline with one target's results written in, its headline recomputed from every target. */
export function withTarget(gold: readonly GoldCase[], baseline: RecallBaseline | null, target: string, cases: Record<string, Served>): RecallBaseline {
  const targets = { ...(baseline?.targets ?? {}), [target]: summarize(gold, cases) };
  const ordered = Object.fromEntries(Object.keys(targets).sort().map((name) => [name, targets[name]!]));
  return {
    version: 1,
    caseCount: gold.length,
    recallQuality: Math.min(...Object.values(ordered).map((t) => t.recallQuality)),
    targets: ordered,
  };
}

export interface Comparison {
  /** Cases worse on any axis: an expected spore lost, an unwanted item gained, or a lower graded score. */
  regressions: string[];
  /** Cases better and worse on none: the baseline undersells this release. */
  improvements: string[];
  /** Cases serving something else at the same score: the baseline no longer describes this release. */
  drift: string[];
}

const servedOf = (c: Served): Served => ({ spores: c.spores, plans: c.plans });
const figure = (n: number): string => n.toFixed(4);

export function compareToBaseline(gold: readonly GoldCase[], current: Record<string, Served>, baseline: TargetBaseline): Comparison {
  const regressions: string[] = [];
  const improvements: string[] = [];
  const drift: string[] = [];
  for (const g of gold) {
    const measured = current[g.id];
    const recorded = baseline.cases[g.id];
    if (measured === undefined) throw new Error(`no served block measured for ${g.id}`);
    if (recorded === undefined) { drift.push(`${g.id}: not in the baseline`); continue; }
    const now = servedOf(measured);
    const then = servedOf(recorded);
    const before = scoreCase(g, then);
    const after = scoreCase(g, now);
    const lost = before.expectedServed.filter((id) => !after.expectedServed.includes(id));
    // A must-not is named, so gaining one is judged by identity. Plans, and on a negative its spores, are unwanted
    // without being named: one swapped for another is the same failure, so only more of them is worse. The two are
    // counted apart, so spores taking the places plans held on a negative still reads as worse.
    const named = (served: Served) => served.spores.filter((id) => g.mustNot.includes(id));
    const gainedNamed = named(now).filter((id) => !named(then).includes(id));
    const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
    const worse: string[] = [];
    if (lost.length > 0) worse.push(`no longer serves expected ${lost.join(', ')}`);
    if (gainedNamed.length > 0) worse.push(`now serves must-not ${gainedNamed.join(', ')}`);
    if (g.kind === 'negative' && now.spores.length > then.spores.length) {
      worse.push(`now serves ${plural(now.spores.length, 'spore')} (was ${then.spores.length})`);
    }
    if (now.plans.length > then.plans.length) worse.push(`now serves ${plural(now.plans.length, 'plan')} (was ${then.plans.length})`);
    if (round(after.graded) < round(before.graded)) worse.push(`graded score fell ${figure(before.graded)} → ${figure(after.graded)}`);
    if (worse.length > 0) regressions.push(`${g.id}: ${worse.join('; ')}`);
    else if (round(after.graded) > round(before.graded) || (after.pass && !before.pass)) {
      improvements.push(`${g.id}: graded score rose ${figure(before.graded)} → ${figure(after.graded)}${after.pass && !before.pass ? ', now passes' : ''}`);
    } else if (JSON.stringify(now) !== JSON.stringify(then)) {
      drift.push(`${g.id}: served ${JSON.stringify(now)}, baseline ${JSON.stringify(then)}`);
    }
  }
  return { regressions, improvements, drift };
}

/** What recording would change, case by case, in the words a reviewer reads. */
export function describeComparison(target: string, comparison: Comparison): string {
  const section = (title: string, lines: string[]) => lines.length === 0 ? [] : [`  ${title} (${lines.length}):`, ...lines.map((l) => `    ${l}`)];
  const { regressions, improvements, drift } = comparison;
  return [
    `recall gold set, ${target}: ${regressions.length} regressed, ${improvements.length} improved, ${drift.length} changed at the same score`,
    ...section('regressed', regressions),
    ...section('improved', improvements),
    ...section('changed', drift),
  ].join('\n');
}

const round = (n: number): number => Math.round(n * 10_000) / 10_000;
