import { runnerFallbackSince, runnerFallbackWords, storedKeyFailureTitle, type RunnerFallbackNotice } from '@goondocks/myco-shared/runner-fleet';
import { Card, HealthDot, StatusChip } from '../../design';
import { harnessLabel } from '../../lib/harness';

interface RunnerNotice extends RunnerFallbackNotice { runnerName: string }

const stateLabels = { out_of_credit: 'Out of credit', invalid_key: 'Rejected', no_key: 'No usable key' } as const;

/** One active fallback notice per agent, with the runners using their own sign-ins. */
export function RunnerFallbackStatus({ notices }: { notices: readonly RunnerNotice[] }) {
  const agents = new Map<string, RunnerNotice[]>();
  for (const notice of notices) {
    const group = agents.get(notice.agent);
    if (group === undefined) agents.set(notice.agent, [notice]);
    else group.push(notice);
  }
  return [...agents].map(([agent, group]) => {
    const { reason, slot } = group[0]!;
    const since = Math.min(...group.map(notice => notice.since));
    const information = reason === 'out_of_credit';
    const keyState = storedKeyFailureTitle(reason, slot).replace(/^The /, '');
    return (
      <Card key={agent} className="my-s2 flex flex-col gap-s2" aria-label={`${harnessLabel(agent)} sign-in fallback`} role={information ? 'status' : 'alert'}>
        <div className="flex flex-wrap items-center gap-s2">
          <HealthDot tone={information ? 'faint' : 'warn'} label={information ? 'Information' : 'Needs attention'} />
          <StatusChip tone={information ? 'neutral' : 'warn'}>{stateLabels[reason]} · using runners’ own sign-in</StatusChip>
        </div>
        <p className="t-body font-medium text-ink">{harnessLabel(agent)} · {keyState} · Since {runnerFallbackSince(since)}</p>
        <p className="t-small text-ink-2">{group.map(notice => notice.runnerName).sort().join(', ')}</p>
        <p className="t-small text-ink-2">{runnerFallbackWords(reason, slot)}</p>
      </Card>
    );
  });
}
