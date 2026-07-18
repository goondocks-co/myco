import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

/**
 * Team Host operator-side serving status (E-4 W1 Task T6, consuming Task
 * T4b's `GET /api/host-serve/status` — `daemon/api/host-serve-status.ts`).
 * Shared by BOTH dashboard cards (`TeamHostServingCard` on Machine,
 * `TeamHostServedCard` on Grove, decision-ef693c71 D2) so there is exactly
 * one poll for this machine's serving status, not one per card.
 */

export interface HostServeExternalMcpStatus {
  enabled: boolean;
  port: number;
  bound: boolean | null;
  token_present: boolean;
}

/** Every field here is a health-classifier `kind` string (e.g. `'ok'`,
 *  `'stale'`, `'missing_key'`) — see `healthBadgeVariant`/
 *  `humanizeHealthKind` in `lib/constants.ts` for turning one into a badge. */
export interface HostServeHealthStatus {
  designation: string;
  backup: string;
  key: string;
  mcp_coherence: string;
}

export interface HostServeStatusServing {
  serving: true;
  served_grove_id: string | null;
  served_grove_name: string | null;
  overlay_address: string;
  host_id: string | null;
  label: string | null;
  external_mcp: HostServeExternalMcpStatus;
  bearer_present: boolean;
  health: HostServeHealthStatus;
}

export interface HostServeStatusNotServing {
  serving: false;
}

export type HostServeStatusResponse = HostServeStatusServing | HostServeStatusNotServing;

const HOST_SERVE_STATUS_KEY = ['host-serve-status'] as const;

/**
 * GET /api/host-serve/status. Interval matches the server's own 15s cache
 * TTL (`HOST_SERVE_STATUS_CACHE_TTL_MS`, `daemon/api/host-serve-status.ts`)
 * — the same "stay at the server's own TTL" reasoning
 * `useHostMembershipHealth` gives for its identical figure: a poll tick
 * then always lands inside the server's own cache window instead of
 * forcing a fresh config/disk read.
 *
 * `{serving:false}` is the outcome for the large majority of machines,
 * which never act as a Team Host — both consuming cards render null for
 * that state, so there is nothing on screen a poll could usefully refresh.
 * `refetchInterval` is therefore a function, not a fixed
 * `POLL_INTERVALS.HOST_SERVE_STATUS`: once a response comes back
 * `{serving:false}` it turns itself off. This is NOT the same "never a
 * background probe" contract `useHostMembershipHealth` enforces
 * (decision-ef693c71 D3 covers a live-reachability PROBE fired from an
 * open slideout; this route is a cheap cached local read with an
 * unconditional-positive contract) — polling here just has nothing worth
 * refreshing once the answer is a static "no". A later page mount (past
 * the global `STALE_TIME`) re-fetches once and re-arms polling if serving
 * has since turned on.
 */
export function useHostServeStatus() {
  return usePowerQuery<HostServeStatusResponse>({
    queryKey: HOST_SERVE_STATUS_KEY,
    queryFn: ({ signal }) => fetchJson<HostServeStatusResponse>('/host-serve/status', { signal }),
    refetchInterval: (query) => (query.state.data?.serving === false ? false : POLL_INTERVALS.HOST_SERVE_STATUS),
    pollCategory: 'standard',
    // Machine-global (this box's own serving posture), not project-scoped —
    // same precedent as useMachineConfig/useUpgradeStatus/useLogs. Without
    // this, usePowerQuery's default project-scoped key fragments the cache
    // per project and forces a redundant refetch on every project switch.
    contextFree: true,
  });
}
