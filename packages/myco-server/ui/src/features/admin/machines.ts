/**
 * Machines, as the admin pages list them.
 *
 * The server has no list of machines yet: a machine is known by the
 * credentials its runtimes signed in with, each naming the machine and, when
 * `myco login` gave one, the name the runtime took. So the machines here are
 * built from `/api/credentials`, grouped by machine. When the server lists
 * machines with their names itself, `useMachines` reads that list instead and
 * every page above it stays as it is.
 */
import { useMemo } from 'react';
import { usePaged } from '../../hooks/use-paged';
import type { WorkerRow } from '../../lib/api';
import type { CredentialRow } from './wire';

/** What a worker says of where it runs. */
export type WorkerLike = Pick<WorkerRow, 'credentialId' | 'machineId'>;

/** The `revokedBy` of a credential the Deployment ended because it was used from two places; no member acted. */
export const LINEAGE_REPLAY_ACTOR = 'lineage-replay';

/** Where a machine stands, from its credentials: allowed to write, stopped, or run out. */
export type MachineStanding = 'allowed' | 'stopped' | 'replayed' | 'expired';

export interface Machine {
  /** The machine's id, or its first credential's for a runtime that named no machine. Never shown. */
  key: string;
  machineId: string | null;
  /** What the machine is called: the name its runtime took, else "A machine" or "Machine 2". */
  name: string;
  /** Whether `name` is the machine's own, not a stand-in. */
  named: boolean;
  /** The member it belongs to. */
  memberId: string;
  /** Its credentials, newest first. */
  credentials: CredentialRow[];
  /** Those that authenticate now. */
  live: CredentialRow[];
  standing: MachineStanding;
  /** Who stopped it, as a member id, when a member did. */
  stoppedBy: string | null;
  /** When it first signed in. */
  firstSeenAt: number;
}

function standingOf(credentials: readonly CredentialRow[]): { standing: MachineStanding; stoppedBy: string | null } {
  if (credentials.some((c) => c.live)) return { standing: 'allowed', stoppedBy: null };
  const newest = credentials[0];
  if (newest !== undefined && newest.revokedAt !== null) {
    return newest.revokedBy === LINEAGE_REPLAY_ACTOR
      ? { standing: 'replayed', stoppedBy: null }
      : { standing: 'stopped', stoppedBy: newest.revokedBy };
  }
  return { standing: 'expired', stoppedBy: null };
}

const hasLabel = (c: CredentialRow): boolean => c.runtimeLabel !== null && c.runtimeLabel.trim() !== '';

/**
 * A member's runtimes grouped by the machine they run on, newest first and the
 * machines allowed to write before the rest. A machine takes the name of its
 * newest live runtime that gave one, else of any that did; a machine with no
 * name reads "A machine" when it is the only one, else "Machine 1",
 * "Machine 2" in the order listed. Run credentials belong to runs, not
 * machines, and are left out.
 */
export function machinesFrom(rows: readonly CredentialRow[]): Machine[] {
  const groups = new Map<string, CredentialRow[]>();
  for (const row of rows) {
    if (row.purpose !== 'member') continue;
    const key = row.machineId ?? `lineage:${row.lineageRoot}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const built = [...groups.entries()].map(([key, credentials]) => {
    const sorted = [...credentials].sort((a, b) => b.lineageStartedAt - a.lineageStartedAt);
    const live = sorted.filter((c) => c.live);
    const label = (live.find(hasLabel) ?? sorted.find(hasLabel))?.runtimeLabel?.trim() ?? null;
    return {
      key,
      machineId: sorted[0]!.machineId,
      label,
      memberId: sorted[0]!.memberId,
      credentials: sorted,
      live,
      ...standingOf(sorted),
      firstSeenAt: Math.min(...sorted.map((c) => c.lineageStartedAt)),
      latest: sorted[0]!.lineageStartedAt,
    };
  });
  built.sort((a, b) => Number(b.live.length > 0) - Number(a.live.length > 0) || b.latest - a.latest || a.key.localeCompare(b.key));
  const unnamed = built.filter((m) => m.label === null).map((m) => m.key);
  return built.map(({ label, latest: _latest, ...machine }) => ({
    ...machine,
    name: label ?? (unnamed.length === 1 ? 'A machine' : `Machine ${unnamed.indexOf(machine.key) + 1}`),
    named: label !== null,
  }));
}

/** The machine a worker runs on: the one holding its credential, else the one it names. */
export function machineOfWorker(machines: readonly Machine[], worker: WorkerLike): Machine | undefined {
  return machines.find((m) => m.credentials.some((c) => c.id === worker.credentialId))
    ?? (worker.machineId === null ? undefined : machines.find((m) => m.machineId === worker.machineId));
}

/** The query key every read of the machines' credentials shares, so a stop refreshes each page that lists them. */
export const MACHINE_CREDENTIALS_KEY = ['credentials', 'member'] as const;

/**
 * The machines the viewer may see: every member's to an admin, their own to a
 * member (the server answers a member only their own). Paged 50 credentials at
 * a time; `more()` reads the next page.
 */
export function useMachines() {
  const paged = usePaged<CredentialRow>(MACHINE_CREDENTIALS_KEY, '/api/credentials?purpose=member&limit=50');
  const machines = useMemo(() => machinesFrom(paged.rows), [paged.rows]);
  return { ...paged, machines };
}
