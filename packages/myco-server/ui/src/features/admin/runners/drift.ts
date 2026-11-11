import { profileModelVerdict, type ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import type { RecordedIdentity } from '@goondocks/myco-shared/worker-usage';
import { harnessLabel } from '../../../lib/harness';
import { displayModel } from '../../work/ModelSummary';

/** What one of a runner's runs ran with and was asked for, as `GET /api/runners/{id}/runs` answers each row. */
export interface DriftFacts {
  /** `handed_on` where a later claim took the run on, so its recorded model is that claim's, not this one's. */
  outcome: string;
  runnerVersion: string | null;
  agentVersion: string | null;
  harness: string | null;
  requested: ExecutionProfile | null;
  identity: RecordedIdentity;
}

const runs = (n: number): string => `${n.toLocaleString()} run${n === 1 ? '' : 's'}`;

/** Each value with how many rows hold it, most first; ties keep first-seen order. */
function tally<T>(rows: readonly T[], key: (row: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

const NOT_REPORTED = '\u0000';

/** "2.0.0-alpha.24 for 41 runs, 2.0.0-alpha.23 for 3, not reported for 6": each version over the rows, most first. */
function versionList(counts: ReadonlyArray<[string, number]>): string {
  return counts.map(([version, n]) => `${version === NOT_REPORTED ? 'not reported' : version} for ${runs(n)}`).join(', ');
}

/** The runner versions its shown runs ran with: "Ran 2.0.0-alpha.24 for 41 runs, 2.0.0-alpha.23 for 3"; null for none. */
export function runnerVersionWords(rows: readonly DriftFacts[]): string | null {
  if (rows.length === 0) return null;
  const counts = tally(rows, (row) => row.runnerVersion ?? NOT_REPORTED);
  if (counts.length === 1 && counts[0]![0] === NOT_REPORTED) return `Its version was not reported for any of the ${runs(rows.length)} shown`;
  return `Ran ${versionList(counts)}`;
}

/** The coding agent versions its shown runs ran with, per agent: "Claude Code 2.1.3 for 30 runs, 2.1.2 for 5 · Codex 0.50.0 for 6". */
export function agentVersionWords(rows: readonly DriftFacts[]): string | null {
  const byAgent = new Map<string, DriftFacts[]>();
  for (const row of rows) byAgent.set(row.harness ?? '', [...(byAgent.get(row.harness ?? '') ?? []), row]);
  if (byAgent.size === 0) return null;
  return [...byAgent].sort((a, b) => b[1].length - a[1].length)
    .map(([harness, held]) => `${harness === '' ? 'Agent not recorded' : harnessLabel(harness)} ${versionList(tally(held, (row) => row.agentVersion ?? NOT_REPORTED))}`)
    .join(' · ');
}

/** How a run's model compares with what it was asked for, on its own record and nothing else. */
export type ModelState = 'match' | 'mismatch' | 'unconfirmed' | 'unasked' | 'launched' | 'unreported';

/** One comparison state: the agent, the model asked for and what it resolves to, the model recorded, and how they compare. */
export interface ModelDriftLine { words: string; runs: number; state: ModelState }

const STATE_WORDS: Readonly<Record<ModelState, (used: string) => string>> = {
  match: (used) => `ran ${used}`,
  mismatch: (used) => `ran ${used}, a different model than asked`,
  unconfirmed: (used) => `ran ${used}; the provider chooses which model this name runs, so it can’t be confirmed`,
  unasked: (used) => `ran ${used}`,
  launched: (used) => `launched with ${used}; the agent did not report what it ran`,
  unreported: () => 'model not reported',
};

function modelState(row: DriftFacts): ModelState {
  if (row.identity.status === 'launched') return 'launched';
  if (row.identity.status !== 'reported') return 'unreported';
  if (row.requested === null || row.harness === null) return 'unasked';
  return profileModelVerdict(row.harness, row.requested, row.identity.primary);
}

/**
 * The models the shown runs recorded against what each was asked for, one line per comparison state, most first: runs
 * share a line only when the agent, the model asked for, what it resolves to, the model recorded and their verdict all
 * agree. Only a claim that is its run's latest counts: a run's recorded model is its latest claim's. Only a model the
 * agent reported and that matches counts as running the model asked for.
 */
export function modelDrift(rows: readonly DriftFacts[]): { headline: string | null; lines: ModelDriftLine[] } {
  const counted = rows.filter((row) => row.outcome !== 'handed_on');
  const lines = new Map<string, ModelDriftLine>();
  const states = new Map<ModelState, number>();
  for (const row of counted) {
    const state = modelState(row);
    states.set(state, (states.get(state) ?? 0) + 1);
    const ran = row.identity.status === 'reported' || row.identity.status === 'launched' ? row.identity.primary : null;
    const used = ran === null ? '' : `${ran.provider === undefined ? '' : `${ran.provider}/`}${ran.model}`;
    const asked = row.requested === null ? 'No model asked'
      : `Asked for ${displayModel(row.requested.model)}${row.requested.resolvesTo === undefined ? '' : ` (resolves to ${row.requested.resolvesTo})`}`;
    const words = `${row.harness === null ? 'Unknown agent' : harnessLabel(row.harness)}: ${asked}, ${STATE_WORDS[state](used)}`;
    const line = lines.get(words) ?? { words, runs: 0, state };
    lines.set(words, { ...line, runs: line.runs + 1 });
  }
  const confirmed = states.get('match') ?? 0;
  const judged = confirmed + (states.get('mismatch') ?? 0) + (states.get('unconfirmed') ?? 0);
  const unconfirmed = states.get('unconfirmed') ?? 0;
  const launched = states.get('launched') ?? 0;
  const parts = [
    ...(judged === 0 ? [] : [`Ran the model it was asked for in ${confirmed.toLocaleString()} of ${runs(judged)} whose agent reported its model`]),
    ...(unconfirmed === 0 ? [] : [`${runs(unconfirmed)} can’t be confirmed`]),
    ...(launched === 0 ? [] : [`${runs(launched)} recorded only the model ${launched === 1 ? 'it was' : 'they were'} launched with`]),
  ];
  return {
    headline: parts.length === 0 ? null : parts.join('; '),
    lines: [...lines.values()].sort((a, b) => b.runs - a.runs).map((line) => ({ ...line, words: `${line.words}: ${runs(line.runs)}` })),
  };
}
