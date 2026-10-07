/** Machines as the canonical claim summary names them. */
import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchJson, type WorkerRow } from '../../lib/api';
import type { MachinesAnswer } from './wire';

/** What a worker says of where it runs. */
export type WorkerLike = Pick<WorkerRow, 'credentialId' | 'machineId'>;

/** Where a machine stands in its server summary. */
export type MachineStanding = 'allowed' | 'stopped' | 'replayed' | 'expired';

export interface Machine {
  /** The claim's id. Never shown. */
  key: string;
  machineId: string | null;
  /** What the machine is called: the name its runtime took, else "A machine" or "Machine 2". */
  name: string;
  /** Whether `name` is the machine's own, not a stand-in. */
  named: boolean;
  /** The member it belongs to. */
  memberId: string;
  standing: MachineStanding;
  /** Who stopped it, as a member id, when a member did. */
  stoppedBy: string | null;
  /** When it first signed in. */
  firstSeenAt: number;
  liveCredentialCount: number;
  canStop: boolean;
  stopReason: string | null;
  credentialCount: number;
  bytesWritten: number;
}

/** The machine a worker names. */
export function machineOfWorker(machines: readonly Machine[], worker: WorkerLike): Machine | undefined {
  return worker.machineId === null ? undefined : machines.find((m) => m.machineId === worker.machineId);
}

/** The query key every machine summary read shares. */
export const MACHINE_LIST_KEY = ['machines'] as const;

/** Claims the viewer may see, one bounded server page at a time. */
export function useMachines(options: { enabled?: boolean } = {}) {
  const query = useInfiniteQuery({
    queryKey: MACHINE_LIST_KEY,
    initialPageParam: null as string | null,
    enabled: options.enabled ?? true,
    queryFn: ({ pageParam, signal }) => fetchJson<MachinesAnswer>(`/api/machines?limit=50${pageParam === null ? '' : `&cursor=${encodeURIComponent(pageParam)}`}`, signal),
    getNextPageParam: (last) => last.cursor ?? undefined,
  });
  const rows = useMemo(() => [...new Map((query.data?.pages.flatMap((answer) => answer.machines) ?? []).map((row) => [row.machineId, row])).values()], [query.data]);
  const machines = useMemo(() => {
    const unnamed = rows.filter((row) => row.name === null);
    return rows.map((row): Machine => ({
      key: row.machineId, machineId: row.machineId,
      name: row.name ?? (unnamed.length === 1 ? 'A machine' : `Machine ${unnamed.findIndex((item) => item.machineId === row.machineId) + 1}`),
      named: row.name !== null, memberId: row.member.id,
      standing: row.standing, stoppedBy: row.stoppedBy, firstSeenAt: row.firstSeenAt,
      liveCredentialCount: row.liveCredentialCount, credentialCount: row.credentialCount, bytesWritten: row.bytesWritten,
      canStop: row.canStop === true, stopReason: row.stopReason ?? null,
    }));
  }, [rows]);
  return {
    machines, isPending: query.isPending, error: query.error, hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    more: () => { void query.fetchNextPage({ cancelRefetch: false }); },
    retry: () => { void (query.isFetchNextPageError ? query.fetchNextPage({ cancelRefetch: false }) : query.refetch()); },
  };
}
