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
      return answer.machine === null ? null : { ...toMachine(answer.machine, 'A machine'), facts: answer.contactFacts };
    },
    ...live({ follows: ['fleet', 'sessions'] }),
  });
}

/** Which runner registration a page is for: the one that reported this machine id, or one runner by its own id. */
export type RunnerMatch = { machineId: string } | { runnerId: string };

const matches = (match: RunnerMatch) => (runner: RunnerRow): boolean =>
  'machineId' in match ? runner.machineId === match.machineId : runner.id === match.runnerId;

/**
 * Every runner registration on a machine, or the one a runner id names: the active ones from every page of the runner
 * list, in its order, then the removed ones from every page of theirs, with the legacy workers on the same machine.
 * Nothing is picked for the reader: each registration is listed with its own id. `settled` once every page is read.
 */
export function useRunnersOn(match: RunnerMatch) {
  const active = useRunnerPages({ all: true });
  const activeRead = active.query.isSuccess && !active.query.hasNextPage;
  const removed = useRemovedRunnerPages(activeRead, { all: true });
  const removedRead = removed.query.isSuccess && !removed.query.hasNextPage;
  const test = matches(match);
  const legacy = 'machineId' in match ? (active.query.data?.pages[0]?.legacyWorkers ?? []).filter((worker) => worker.machineId === match.machineId) : [];
  return {
    runners: [...active.runners.filter(test), ...removed.runners.filter(test)],
    legacy,
    settled: activeRead && removedRead,
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
