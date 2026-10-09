import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, ErrorState } from '../../../design';
import { permissionOf, useMe } from '../../../hooks/use-me';
import { fetchJson, postJson, type RunnerRow } from '../../../lib/api';
import { formatRelative } from '../../../lib/format';
import { AdminPage, AdminSection } from '../AdminFrame';

const RUNNERS_KEY = ['runners'] as const;

/** The Deployment's execution machines and their between-run updates, readable by every member. */
export function RunnersPage() {
  const runners = useQuery({ queryKey: RUNNERS_KEY, queryFn: ({ signal }) => fetchJson<{ runners: RunnerRow[] }>('/api/runners', signal), refetchInterval: 15_000 });
  const permission = permissionOf(useMe().data, 'runners');
  return (
    <AdminPage name="runners" scope="server" title="Runners" lede="The machines that run Myco’s work. Updates stay in each runner’s release channel and wait for its current run to finish.">
      <AdminSection id="runners" title="Registered runners">
        {runners.isError && <ErrorState error={runners.error} onRetry={() => void runners.refetch()} />}
        {runners.isPending && <p className="t-body text-muted">Loading runners…</p>}
        {runners.data?.runners.length === 0 && <p className="t-body text-muted">No runners are registered. Run <code>myco runner register &lt;address&gt;</code> on a machine to enroll it.</p>}
        <div className="divide-y divide-line rounded-card border border-line">
          {runners.data?.runners.map((runner) => <RunnerCard key={runner.id} runner={runner} allowed={permission.allowed} />)}
        </div>
      </AdminSection>
    </AdminPage>
  );
}

function RunnerCard({ runner, allowed }: { runner: RunnerRow; allowed: boolean }) {
  const client = useQueryClient();
  const update = useMutation({ mutationFn: () => postJson(`/api/runners/${encodeURIComponent(runner.id)}/update`, {}), onSuccess: async () => { await client.invalidateQueries({ queryKey: RUNNERS_KEY }); } });
  const result = runner.lastResult;
  const blocked = runner.blockedVersion;
  const state = runner.updateState;
  const resultWords = result === null ? 'No update result reported.' : `${result.result === 'updated' ? 'Updated' : result.result === 'no_update' ? 'Already current' : result.result === 'rolled_back' ? 'Rolled back' : result.result === 'refused' ? 'Update refused' : 'Update failed'} · ${result.fromVersion} → ${result.toVersion} · ${formatRelative(result.at)}${result.reason ? ` · ${result.reason}` : ''}`;
  return (
    <article className="flex flex-col gap-s3 p-s4 sm:flex-row sm:items-start sm:justify-between" data-runner={runner.id}>
      <div className="flex min-w-0 flex-col gap-s2">
        <h3 className="t-h3 text-ink">{runner.name}</h3>
        <p className="t-small text-muted">{runner.state === 'removed' ? 'Removed' : runner.connected ? runner.busy === null ? 'Connected · idle' : 'Connected · running' : 'Offline'} · {runner.version ?? 'Version unknown'} · {runner.channel ?? 'Channel unknown'}</p>
        <p className="t-small text-muted">{runner.offers == null ? 'Agents offered: unknown (no service offer reported).' : `Agents offered: ${runner.offers.filter(offer => offer.authenticated).map(offer => offer.id).join(', ') || 'none'} · observed ${runner.offersObservedAt == null ? 'unknown' : new Date(runner.offersObservedAt).toLocaleString()}.`}</p>
        {runner.latestVersion !== null && runner.latestVersion !== runner.version && <p className="t-small text-ink">Update available: {runner.latestVersion}</p>}
        <p className="t-small text-muted">{runner.lastCheckAt === null ? 'No update check reported.' : `Last checked ${formatRelative(runner.lastCheckAt)}.`}</p>
        <p className="t-small text-muted">{resultWords}</p>
        {blocked != null && <p className="t-small text-ink">Blocked release: {blocked.version} · {blocked.until > Date.now() ? 'retry after' : 'block expired'} {new Date(blocked.until).toLocaleString()} · {blocked.reason}</p>}
        {state != null && <p role="status" className="t-small text-ink">{state.phase === 'updating' ? 'Updating · execution held' : state.phase === 'probation' ? 'Health probation' : 'Cleanup pending · execution continues'} · since {formatRelative(state.since)}{state.reason ? ` · ${state.reason}` : ''}</p>}
        {runner.channel === null && runner.state !== 'removed' && <p className="t-small text-muted">Dashboard updates require a runner that reports its installed release channel.</p>}
        {runner.updateRequest !== null && <p role="status" className="t-small text-muted">Update requested · {runner.busy === null ? 'waiting for the runner' : 'waiting for the current run to finish'}.</p>}
        {update.isError && <ErrorState error={update.error} onRetry={() => update.mutate()} />}
      </div>
      {allowed && runner.state !== 'removed' && <Button disabled={!runner.connected || runner.channel === null || runner.updateRequest !== null || update.isPending} onClick={() => update.mutate()}>{update.isPending ? 'Requesting…' : blocked != null ? 'Clear block and update' : 'Update now'}</Button>}
    </article>
  );
}
