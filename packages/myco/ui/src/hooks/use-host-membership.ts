import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePowerQuery } from './use-power-query';
import { fetchJson, postJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

/**
 * Team Host membership hooks (consolidation Task D-2) — the Team page's
 * primary React Query surface, wrapping `POST /api/host-membership/
 * join|leave|attach|detach` and `GET /api/host-membership/status`
 * (`daemon/api/host-membership.ts`). Every mutation invalidates the status
 * query on settle so the host list / attach state / hint reflect the write
 * immediately, matching `use-content-claims.ts`'s pattern.
 */

// ---------------------------------------------------------------------------
// Status (read)
// ---------------------------------------------------------------------------

export interface HostMembershipProjectRef {
  grove_id: string;
  project_id: string;
  root: string | null;
}

export interface HostMembershipHost {
  host_id: string;
  label: string;
  overlay_address: string;
  proxy_port: number | null;
  protocol_version: number;
  created_at: string;
  projects: HostMembershipProjectRef[];
}

export interface HostMembershipHint {
  host_id: string;
  state: 'not_joined' | 'not_attached';
  message: string;
}

export interface HostMembershipStatusResponse {
  hosts: HostMembershipHost[];
  hint: HostMembershipHint | null;
}

const HOST_MEMBERSHIP_STATUS_KEY = ['host-membership-status'] as const;

/** GET /api/host-membership/status — every joined host + its attach refs,
 *  plus (when `projectRoot` is given) that project's affiliation-hint state. */
export function useHostMembershipStatus(projectRoot?: string) {
  const suffix = projectRoot ? `?project_root=${encodeURIComponent(projectRoot)}` : '';
  return usePowerQuery<HostMembershipStatusResponse>({
    queryKey: [...HOST_MEMBERSHIP_STATUS_KEY, projectRoot ?? null],
    queryFn: ({ signal }) => fetchJson<HostMembershipStatusResponse>(`/host-membership/status${suffix}`, { signal }),
    refetchInterval: POLL_INTERVALS.HOST_MEMBERSHIP,
    pollCategory: 'standard',
  });
}

function useInvalidateHostMembershipStatus() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: HOST_MEMBERSHIP_STATUS_KEY });
}

// ---------------------------------------------------------------------------
// join / leave
// ---------------------------------------------------------------------------

export interface JoinHostInput {
  host_ref: string;
  key: string;
  server_url?: string;
  hostname?: string;
  overlay_address?: string;
  bearer?: string;
  protocol_version?: number;
  host_id?: string;
  label?: string;
}

export interface JoinHostResponse {
  host_id: string;
  overlay_address: string;
  proxy_port: number;
  member_overlay_ip: string;
  host_reachable: boolean;
  created: boolean;
  notes: string[];
}

/** POST /api/host-membership/join — the Team page's join form. Provisions a
 *  userspace tailscaled + enrolls over the overlay; can take real seconds
 *  (no client-side timeout override needed here — `fetchJson` uses the
 *  browser's own fetch, which has no default timeout). */
export function useJoinHost() {
  const invalidate = useInvalidateHostMembershipStatus();
  return useMutation({
    mutationFn: (input: JoinHostInput) => postJson<JoinHostResponse>('/host-membership/join', input),
    onSettled: invalidate,
  });
}

export interface LeaveHostResponse {
  removed: boolean;
  tailscaled_removed: boolean;
  notes: string[];
}

/** POST /api/host-membership/leave. */
export function useLeaveHost() {
  const invalidate = useInvalidateHostMembershipStatus();
  return useMutation({
    mutationFn: (hostRef: string) => postJson<LeaveHostResponse>('/host-membership/leave', { host_ref: hostRef }),
    onSettled: invalidate,
  });
}

// ---------------------------------------------------------------------------
// attach / detach
// ---------------------------------------------------------------------------

export interface AttachProjectInput {
  project_root: string;
  host_id?: string;
  grove_id: string;
  project_id?: string;
}

export interface AttachProjectResponse {
  project_id: string;
  grove_id: string;
  host_id: string;
  host_label: string;
  root: string;
  already_attached: boolean;
  notes: string[];
}

/** POST /api/host-membership/attach — the Team page's per-project attach control. */
export function useAttachProject() {
  const invalidate = useInvalidateHostMembershipStatus();
  return useMutation({
    mutationFn: (input: AttachProjectInput) => postJson<AttachProjectResponse>('/host-membership/attach', input),
    onSettled: invalidate,
  });
}

export interface DetachProjectResponse {
  project_id: string;
  detached_from_host_id: string | null;
}

/** POST /api/host-membership/detach. */
export function useDetachProject() {
  const invalidate = useInvalidateHostMembershipStatus();
  return useMutation({
    mutationFn: (input: { project_root: string; project_id?: string }) =>
      postJson<DetachProjectResponse>('/host-membership/detach', input),
    onSettled: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Drain health (consolidation Task C-5's status API — first UI consumer)
// ---------------------------------------------------------------------------

export interface DrainCounters {
  pending_entries: number;
  pending_bytes?: number;
  pending_records?: number;
  failing_entries: number;
  host_unreachable_entries: number;
}

export interface DrainHealthHost {
  host_id: string;
  label: string;
  drains: {
    transcript: DrainCounters;
    plan: DrainCounters;
    event_replay: DrainCounters;
  };
}

export interface DrainHealthResponse {
  hosts: DrainHealthHost[];
}

/** GET /api/team-host/drain-health (Task C-5) — per-host pending/failing
 *  counters for the three member drains. Poll-friendly persisted-state read;
 *  no live reachability probe (that's `myco doctor`-only). */
export function useDrainHealth() {
  return usePowerQuery<DrainHealthResponse>({
    queryKey: ['team-host-drain-health'],
    queryFn: ({ signal }) => fetchJson<DrainHealthResponse>('/team-host/drain-health', { signal }),
    refetchInterval: POLL_INTERVALS.DRAIN_HEALTH,
    pollCategory: 'standard',
  });
}
