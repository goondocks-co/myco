import { useMutation, useQueryClient } from '@tanstack/react-query';
import { agoWords, dateTimeWords } from '@goondocks/myco-shared/time-words';
import { Button, ErrorState } from '../../../design';
import { useIsAdmin } from '../../../hooks/use-me';
import { postJson, type RunnerRow } from '../../../lib/api';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';
import type { Machine } from '../machines';
import { MachineUpdates } from '../people/MachineUpdates';
import { refreshFleet } from '../runners/LegacyWorker';

const RESULT_WORDS = { updated: 'Updated', no_update: 'Already current', rolled_back: 'Rolled back', refused: 'Update refused', failed: 'Update failed' } as const;

/**
 * How the machine stays current: the release its runner reported and a way to update it between runs, and its own
 * update preferences, which only its member changes.
 */
export function CurrentPart({ claim, runners, viewerId }: { claim: Machine | null; runners: readonly RunnerRow[]; viewerId: string | null }) {
  const signedIn = claim !== null && claim.standing === 'allowed' && claim.machineId !== null;
  const running = runners.filter((runner) => runner.state !== 'removed');
  if (!signedIn && running.length === 0) return null;
  return (
    <AdminSection id="current" title="How does it stay current?">
      <RowCard label="How does it stay current?">
        {running.map((runner) => <RunnerRelease key={runner.id} runner={runner} />)}
        {signedIn && (claim.memberId === viewerId
          ? <SettingRow stacked setting="machine-updates" label="Its updates" note="What it last reported, and a change for it to pick up." control={<MachineUpdates machineId={claim.machineId!} name={claim.name} />} />
          : <SettingRow setting="machine-updates" label="Its updates" note="Whether it updates itself, and from which releases, is for its member to change." control={<span />} />)}
      </RowCard>
    </AdminSection>
  );
}

/** The release its runner reported, whether a newer one is out, and a way to update it between runs. */
function RunnerRelease({ runner }: { runner: RunnerRow }) {
  const admin = useIsAdmin();
  const client = useQueryClient();
  const update = useMutation({ mutationFn: () => postJson(`/api/runners/${encodeURIComponent(runner.id)}/update`, {}), onSuccess: () => refreshFleet(client) });
  const result = runner.lastResult;
  const state = runner.updateState;
  const blocked = runner.blockedVersion;
  const lines = [
    runner.channel === null ? 'It reported no release channel, so it can’t be updated from here.' : `It follows the ${runner.channel} releases and updates between runs.`,
    runner.updateAvailable === true ? `A newer release, ${runner.latestVersion}, is out.` : runner.updateMetadataUnavailable ? 'Whether a newer release is out is unknown.' : null,
    runner.lastCheckAt === null ? null : `It last checked for an update ${agoWords(runner.lastCheckAt)}.`,
    runner.updateRequest !== null ? `Update requested; ${runner.busy === null ? 'waiting for the machine' : 'waiting for its current run to finish'}.` : null,
    state == null ? null : `${state.phase === 'updating' ? 'Updating' : state.phase === 'probation' ? 'Checking the update is healthy' : 'Finishing update cleanup'} since ${dateTimeWords(state.since)}${state.reason ? `: ${state.reason}` : ''}.`,
    result === null ? null : `${RESULT_WORDS[result.result]} ${result.fromVersion} → ${result.toVersion} ${agoWords(result.at)}${result.reason ? `: ${result.reason}` : ''}.`,
    blocked == null ? null : blocked.until > Date.now()
      ? `Release ${blocked.version} is held back until ${dateTimeWords(blocked.until)}: ${blocked.reason}.`
      : `Release ${blocked.version} was held back until ${dateTimeWords(blocked.until)}; that hold has ended: ${blocked.reason}.`,
  ].filter((line): line is string => line !== null);
  return (
    <SettingRow
      setting="runner-release"
      label={runner.version === null ? `${runner.name} reported no version` : `${runner.name} is on ${runner.version}`}
      note={lines.join(' ')}
      details={update.isError ? <ErrorState error={update.error} onRetry={() => update.mutate()} /> : undefined}
      control={admin && runner.updateAvailable === true
        ? <Button size="sm" disabled={!runner.connected || runner.channel === null || runner.updateRequest !== null} pending={update.isPending} onClick={() => update.mutate()}>{blocked != null ? `Clear the hold and update ${runner.name}` : `Update ${runner.name} now`}</Button>
        : <span />}
    />
  );
}
