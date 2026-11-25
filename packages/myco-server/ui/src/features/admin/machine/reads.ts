/**
 * What a machine's page reads: the machine's sign-ins by its id, when the viewer may see them, and the runner
 * registration that names the same machine id. The two are joined only by that id.
 */
import { useQuery } from '@tanstack/react-query';
import { useRemovedRunnerPages, useRunnerPages } from '../../../hooks/use-fleet';
import { fetchJson, type RunnerRow } from '../../../lib/api';
import { live } from '../../../lib/live';
import { MACHINE_LIST_KEY, toMachine, type Machine } from '../machines';
import type { MachineAnswer } from '../wire';

/** The machine's sign-ins, or null when the server holds none for this id that the viewer may see. */
export function useMachineClaim(machineId: string | null) {
  return useQuery({
    queryKey: [...MACHINE_LIST_KEY, 'one', machineId],
    enabled: machineId !== null,
    queryFn: async ({ signal }): Promise<Machine | null> => {
      const answer = await fetchJson<MachineAnswer>(`/api/machines/${encodeURIComponent(machineId!)}`, signal);
      return answer.machine === null ? null : toMachine(answer.machine, 'A machine');
    },
    ...live({ follows: ['fleet', 'sessions'] }),
  });
}

/** Which runner registration a page is for: the one that reported this machine id, or one runner by its own id. */
export type RunnerMatch = { machineId: string } | { runnerId: string };

const matches = (match: RunnerMatch) => (runner: RunnerRow): boolean =>
  'machineId' in match ? runner.machineId === match.machineId : runner.id === match.runnerId;

/**
 * The runner registration on a machine: among the active runners, every page of them, the one most recently seen
 * that matches; else, once the active runners are all read, the most recently removed one. `settled` once the answer
 * is final; `others` counts further active registrations that name the same machine.
 */
export function useRunnerOn(match: RunnerMatch) {
  const active = useRunnerPages({ all: true });
  const found = active.runners.filter(matches(match)).sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  const activeRead = active.query.isSuccess && !active.query.hasNextPage;
  const removed = useRemovedRunnerPages(activeRead && found.length === 0);
  const removedFound = removed.runners.find(matches(match));
  const removedRead = removed.query.isSuccess && !removed.query.hasNextPage;
  const runner = found[0] ?? removedFound ?? null;
  return {
    runner,
    others: Math.max(0, found.length - 1),
    settled: activeRead && (found.length > 0 || removedRead || removedFound !== undefined),
    error: active.query.error ?? removed.query.error,
    storedUsable: active.storedUsable,
    retry: () => {
      for (const query of [active.query, removed.query]) {
        if (query.isFetchNextPageError) void query.fetchNextPage();
        else if (query.isError) void query.refetch();
      }
    },
  };
}
