/**
 * The executor the request pipeline authenticated on a worker control route: a legacy worker presenting an
 * administrator's member credential, or a runner presenting its own. Every lease reader and writer branches on it.
 */
export type WorkerPrincipal =
  | { kind: 'member'; tokenId: string; machineId: string }
  | { kind: 'runner'; runnerId: string; credentialId: string; machineId: string | null };

/** What a lease authority is decided on: the member credential a legacy lease names, or a runner and its presenting credential. */
export type LeaseHolder = { kind: 'member'; tokenId: string } | { kind: 'runner'; runnerId: string; credentialId: string };

/** The column pair a lease names for this executor: a member credential in `leased_by`, or a runner and its credential. */
export function leaseOwnerColumns(worker: WorkerPrincipal): { leasedBy: string | null; runnerId: string | null; runnerCredentialId: string | null } {
  return worker.kind === 'member'
    ? { leasedBy: worker.tokenId, runnerId: null, runnerCredentialId: null }
    : { leasedBy: null, runnerId: worker.runnerId, runnerCredentialId: worker.credentialId };
}

/** The key a worker's report is held under in the fleet: its credential for a legacy worker, its stable id for a runner. */
export const workerKey = (worker: WorkerPrincipal): string => (worker.kind === 'member' ? worker.tokenId : worker.runnerId);
