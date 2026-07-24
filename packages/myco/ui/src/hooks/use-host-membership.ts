import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  /** The LOCAL Grove this project displays under (E-4 local-view
   *  requirement) — already resolved server-side: the member's chosen
   *  Grove when it still exists, else the machine's current default Grove.
   *  `null` only in the bootstrap-only case where this machine has no
   *  default Grove yet. A distinct Grove concept from `grove_id` above
   *  (the host's served Grove). */
  local_grove_id: string | null;
  /** `'attach_grove_mismatch'` when this ref's `grove_id` no longer matches
   *  the host's `served_grove_id` (server-mode design spec §2 existing-refs
   *  mitigation); `null` when it matches or the host's designation isn't
   *  known yet. */
  mismatch: 'attach_grove_mismatch' | null;
}

export interface HostMembershipHost {
  host_id: string;
  label: string;
  overlay_address: string;
  proxy_port: number | null;
  protocol_version: number;
  /** The host's self-reported served Grove (protocol v2). `null` when the
   *  host predates served-grove designation or hasn't designated one yet. */
  served_grove_id: string | null;
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
  return () => {
    void qc.invalidateQueries({ queryKey: HOST_MEMBERSHIP_STATUS_KEY });
    // Membership changes alter which routes degrade for a project — attach
    // turns routes off (e.g. git status starts 409ing), detach/leave turn
    // them back on. The degrade-affected queries deliberately STOP polling
    // once they've seen the hosted-refusal (`useGitIdentity`'s storm fix),
    // so without this nudge the topbar git pill would stay stuck in its
    // unavailable state after a detach until something else remounted it.
    // Prefix match: the scoped key is ['git-identity', {projectSelection}].
    void qc.invalidateQueries({ queryKey: ['git-identity'] });
    // Attach/detach kick off (or cancel) a residency round trip. Nudge the
    // residency-status query so the progress line picks the fresh in-flight
    // state up immediately — including the case where the SAME project is
    // transitioned again after a prior one finished, where the query key is
    // unchanged and its self-disarmed poll would otherwise stay parked.
    // Prefix match: the key is ['residency-status', projectId].
    void qc.invalidateQueries({ queryKey: RESIDENCY_STATUS_KEY });
  };
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
  /** joinHost's step-by-step progress log, collected daemon-side (the join
   *  route runs the whole enrollment before answering). Optional: a daemon
   *  mid-upgrade may not send it. */
  steps?: string[];
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
  project_id?: string;
  /** The member's OWN local Grove to show this project under (E-4 local-view
   *  requirement, decision-ef693c71 D1) — a DIFFERENT Grove concept from the
   *  host's served Grove, which the daemon sources from the host record and
   *  never accepts from the caller. Omit to use the machine's default Grove. */
  local_grove_id?: string;
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

export interface DetachProjectInput {
  project_root: string;
  project_id?: string;
  /** Detach even though the host is too old to return this project's data
   *  (Phase F). Sent only after the member explicitly accepts the
   *  `residency_pull_unavailable` fallback ("Disconnect anyway without
   *  bringing data back?"). */
  allow_no_pull?: boolean;
}

/** POST /api/host-membership/detach. */
export function useDetachProject() {
  const invalidate = useInvalidateHostMembershipStatus();
  return useMutation({
    mutationFn: (input: DetachProjectInput) =>
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
    /** Residency-transition ship queue (Phase F) — the attach/detach round
     *  trip's own drain, reported with the same per-kind shape as the other
     *  three so it renders through the shared `DrainCell` with no special
     *  casing. */
    residency: DrainCounters;
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

// ---------------------------------------------------------------------------
// Live health (E-4 W1 Task T4a's probe — first UI consumer, Task T5)
// ---------------------------------------------------------------------------

export interface HostHealthEntry {
  host_id: string;
  label: string;
  reachable: boolean | null;
  checked_at: string;
  protocol_skew: 'none' | 'host_newer' | 'host_older';
}

export interface HostMembershipHealthResponse {
  hosts: HostHealthEntry[];
}

/** Matches the server's own probe cache TTL (`HOST_HEALTH_CACHE_TTL_MS`,
 *  `daemon/api/host-membership.ts`) — staying under it means a re-render
 *  reads the client cache instead of re-issuing a request the server would
 *  just answer from ITS cache anyway. */
const HOST_HEALTH_STALE_MS = 15_000;

/**
 * GET /api/host-membership/health — request-driven only, deliberately NOT a
 * `usePowerQuery` (decision-ef693c71 D3: this must never become a background
 * poll, so there is no power-state-scaled interval to opt into in the first
 * place). `enabled` gates the fetch; passing `false` still returns whatever
 * this query key already has cached (e.g. from an earlier open) without
 * issuing a new probe — the attach panel's reachability hint relies on
 * exactly that read-only-cache behavior.
 *
 * `refetchOnWindowFocus`/`refetchOnReconnect` default to `true` in TanStack
 * Query, and the app's global `QueryClient` (`main.tsx`) only overrides
 * `staleTime` — so without disabling both here, leaving the slideout open
 * past `HOST_HEALTH_STALE_MS` and alt-tabbing back (or a network blip) would
 * fire a live overlay probe outside of "panel open + manual refresh," which
 * is exactly what D3 forbids.
 */
export function useHostMembershipHealth(enabled: boolean) {
  return useQuery({
    queryKey: ['host-membership-health'],
    queryFn: ({ signal }) => fetchJson<HostMembershipHealthResponse>('/host-membership/health', { signal }),
    enabled,
    staleTime: HOST_HEALTH_STALE_MS,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Residency transition status + abort (Phase F, T5) — the attach/detach
// round trip's live progress and its cancel control.
// ---------------------------------------------------------------------------

/** Which way a residency round trip is moving data. */
export type ResidencyDirection = 'attach' | 'detach';

/** Coarse step a residency round trip is on (wire order roughly matches this
 *  order per direction). Rendered as a friendly label in the UI, never raw. */
export type ResidencyPhase = 'parking' | 'pushing' | 'pulling' | 'applying' | 'rehoming';

/**
 * `GET /api/host-membership/residency-status?project_id=…` (localhost member
 * route). `in_flight: false` with the other fields absent is the steady state
 * for a project with no transition running.
 */
export interface ResidencyStatus {
  in_flight: boolean;
  direction?: ResidencyDirection;
  phase?: ResidencyPhase;
  rows_pending?: number | null;
  last_error?: string | null;
}

const RESIDENCY_STATUS_KEY = ['residency-status'] as const;

/**
 * Poll a project's residency-transition status while a round trip may be in
 * flight. Enabled by the caller only after an attach/detach mutation resolves
 * (or when a transition is otherwise known to be underway); it then
 * self-disarms once the daemon reports `in_flight: false`, mirroring
 * `useHostServeStatus`'s conditional `refetchInterval`. `contextFree`: the
 * watch is keyed to a specific project id (the wire query param), independent
 * of whichever project the UI has selected, so it must not be project-scoped.
 */
export function useResidencyStatus(projectId: string | undefined, enabled: boolean) {
  return usePowerQuery<ResidencyStatus>({
    queryKey: [...RESIDENCY_STATUS_KEY, projectId ?? null],
    queryFn: ({ signal }) =>
      fetchJson<ResidencyStatus>(
        `/host-membership/residency-status?project_id=${encodeURIComponent(projectId ?? '')}`,
        { signal },
      ),
    enabled: enabled && Boolean(projectId),
    // Self-disarm: keep polling while a transition may be running, stop the
    // moment the daemon reports there is none. A fresh mutation re-arms this
    // via the residency-status invalidation in useInvalidateHostMembershipStatus.
    refetchInterval: (query) => (query.state.data?.in_flight === false ? false : POLL_INTERVALS.RESIDENCY_STATUS),
    pollCategory: 'standard',
    contextFree: true,
  });
}

export interface ResidencyAbortResponse {
  ok: true;
}

/** POST /api/host-membership/residency-abort — cancel an in-flight transition
 *  and restore the project to its pre-transition state. */
export function useResidencyAbort() {
  const invalidate = useInvalidateHostMembershipStatus();
  return useMutation({
    mutationFn: (input: { project_id: string }) =>
      postJson<ResidencyAbortResponse>('/host-membership/residency-abort', input),
    onSettled: invalidate,
  });
}
