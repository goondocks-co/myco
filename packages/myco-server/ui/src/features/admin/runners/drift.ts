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

/** One pairing of the model asked for and the model a run recorded, with how many shown runs hold it. */
export interface ModelDriftLine { words: string; runs: number; differs: boolean }

/**
 * The models the shown runs recorded against what each was asked for, one line per pairing, most first. Only a claim
 * that is its run's latest counts: a run's recorded model is its latest claim's.
 */
export function modelDrift(rows: readonly DriftFacts[]): { headline: string | null; lines: ModelDriftLine[] } {
  const counted = rows.filter((row) => row.outcome !== 'handed_on');
  const primary = (row: DriftFacts) => row.identity.status === 'reported' || row.identity.status === 'launched' ? row.identity.primary : null;
  const used = (row: DriftFacts): string | null => primary(row)?.model ?? null;
  const differs = (row: DriftFacts): boolean => {
    const ran = primary(row);
    return row.requested !== null && row.harness !== null && ran !== null && profileModelVerdict(row.harness, row.requested, ran) === 'mismatch';
  };
  const pairings = new Map<string, { asked: string | null; used: string | null; runs: number; differs: boolean }>();
  for (const row of counted) {
    const key = `${row.requested?.model ?? NOT_REPORTED}\u0001${used(row) ?? NOT_REPORTED}`;
    const held = pairings.get(key) ?? { asked: row.requested?.model ?? null, used: used(row), runs: 0, differs: differs(row) };
    pairings.set(key, { ...held, runs: held.runs + 1 });
  }
  const lines = [...pairings.values()].sort((a, b) => b.runs - a.runs).map((pairing) => ({
    words: `${pairing.asked === null ? 'No model asked' : `Asked for ${displayModel(pairing.asked)}`}, ${pairing.used === null ? 'model not reported' : `ran ${pairing.used}`}: ${runs(pairing.runs)}${pairing.differs ? ', a different model than asked' : ''}`,
    runs: pairing.runs, differs: pairing.differs,
  }));
  const judged = counted.filter((row) => row.requested !== null && used(row) !== null);
  const headline = judged.length === 0 ? null : `Ran the model it was asked for in ${(judged.length - judged.filter(differs).length).toLocaleString()} of ${runs(judged.length)} that reported one`;
  return { headline, lines };
}
