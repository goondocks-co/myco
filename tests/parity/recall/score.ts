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
 * The release gate is a per-case ratchet on two axes against the baseline
 * recorded for the same target: a case may not stop serving an expected spore
 * it served at the baseline, and may not start serving an unwanted item — a
 * must-not spore, any plan, or for a negative anything — it did not serve at
 * the baseline. Any other change to what a case serves leaves the baseline
 * describing a release that no longer exists, so it fails too and asks for the
 * baseline to be recorded again: the committed baseline is always what this
 * code serves, which is what the Recall quality measure reports.
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

export interface TargetBaseline {
  /** The mean graded score over every case. */
  recallQuality: number;
  passed: number;
  cases: Record<string, Served>;
}

export interface RecallBaseline {
  version: 1;
  caseCount: number;
  /** The lower of the front doors' means: the figure the Recall quality measure shows. */
  recallQuality: number;
  targets: Record<string, TargetBaseline>;
}

/** A target's summary, derived from what each case served. */
export function summarize(gold: readonly GoldCase[], cases: Record<string, Served>): TargetBaseline {
  const scores = gold.map((g) => {
    const served = cases[g.id];
    if (served === undefined) throw new Error(`no served block recorded for ${g.id}`);
    return scoreCase(g, served);
  });
  return {
    recallQuality: round(scores.reduce((sum, s) => sum + s.graded, 0) / scores.length),
    passed: scores.filter((s) => s.pass).length,
    cases,
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
  /** Changes that make a case worse on either axis. */
  regressions: string[];
  /** Any other change to a case's served block: the baseline no longer describes this release. */
  drift: string[];
}

export function compareToBaseline(gold: readonly GoldCase[], current: Record<string, Served>, baseline: TargetBaseline): Comparison {
  const regressions: string[] = [];
  const drift: string[] = [];
  for (const g of gold) {
    const now = current[g.id];
    const then = baseline.cases[g.id];
    if (now === undefined) throw new Error(`no served block measured for ${g.id}`);
    if (then === undefined) { drift.push(`${g.id}: not in the baseline`); continue; }
    const before = scoreCase(g, then);
    const after = scoreCase(g, now);
    const lost = before.expectedServed.filter((id) => !after.expectedServed.includes(id));
    const gained = after.unwanted.filter((id) => !before.unwanted.includes(id));
    if (lost.length > 0) regressions.push(`${g.id}: no longer serves expected ${lost.join(', ')}`);
    if (gained.length > 0) regressions.push(`${g.id}: now serves unwanted ${gained.join(', ')}`);
    if (lost.length === 0 && gained.length === 0 && JSON.stringify(now) !== JSON.stringify(then)) {
      drift.push(`${g.id}: served ${JSON.stringify(now)}, baseline ${JSON.stringify(then)}`);
    }
  }
  return { regressions, drift };
}

const round = (n: number): number => Math.round(n * 10_000) / 10_000;
