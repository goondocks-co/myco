/**
 * Copyright 2026 Chris Kirby
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Client half of the host-admin API family (E1 §4): enable/disable as
 * progress-tracked jobs plus the one-time join-key mint.
 *
 * THE PHASE-2 CONTRACT lives here (spec §4.1 rev 6). An enable/disable
 * response carries `{ token, started_at }`; the job's own terminal state
 * arrives via `GET /api/progress/:token` (written BEFORE the daemon
 * restarts — the tracker dies with the process); and completion of the
 * WHOLE flow is only ever the observed read:
 *
 *   serving && overlay_listener_bound && started_at !== <snapshot>
 *
 * `serving` alone is config-derived and survives every bind failure, and
 * without the `started_at` discriminator the poll succeeds against the
 * dying pre-restart process (a 15s server cache makes that the common
 * case, not the race). The run marker is persisted (localStorage) so a
 * MANUAL refresh during the wait resumes cleanly — the machine-scoped
 * Team page sends no context-switching headers, so the daemon restart's
 * fresh auth token does NOT force a reload here (review N8); persistence
 * is a convenience, and it carries a TTL so a dead run can never wedge
 * the fork (review B1).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../lib/api';
import { HOST_SERVE_STATUS_KEY, type HostServeStatusResponse } from './use-host-serve-status';

export interface HostAdminJobResponse {
  token: string;
  /** THIS daemon process's start stamp — the Phase-2 restart discriminator. */
  started_at: string | null;
  existing?: boolean;
}

export interface ProgressEntryResponse {
  token: string;
  type: string;
  status: 'running' | 'completed' | 'failed';
  percent?: number;
  message?: string;
  steps?: string[];
}

export interface MintJoinKeyResponse {
  join_command: string;
  key: string;
  expires: string;
}

export function useHostAdminEnable() {
  return useMutation({
    mutationFn: (body: {
      server_url: string;
      label?: string;
      storage_name?: string;
      team_provider_key?: string;
      team_key_provider?: string;
    }) => postJson<HostAdminJobResponse>('/host-admin/enable', body),
  });
}

export function useHostAdminDisable() {
  return useMutation({
    mutationFn: () => postJson<HostAdminJobResponse>('/host-admin/disable'),
  });
}

export function useMintJoinKey() {
  return useMutation({
    mutationFn: (body: { expiration?: string } = {}) =>
      postJson<MintJoinKeyResponse>('/host-admin/mint-join-key', body),
  });
}

/**
 * Poll the job's step log. A 404 after the daemon restarted is EXPECTED
 * (the tracker is in-memory and died with the old process) — the terminal
 * step was written before the restart, so a 404 on a token we saw running
 * means "job finished, daemon bounced"; the caller falls through to the
 * Phase-2 status poll rather than reporting an error.
 */
export function useHostAdminProgress(token: string | null) {
  return useQuery<ProgressEntryResponse | null>({
    queryKey: ['host-admin-progress', token],
    enabled: token !== null,
    queryFn: async ({ signal }) => {
      try {
        return await fetchJson<ProgressEntryResponse>(`/progress/${token}`, { signal });
      } catch (err) {
        if (err instanceof Error && /404|not_found/i.test(err.message)) return null;
        throw err;
      }
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // Poll while running; stop once terminal or 404 (daemon bounced).
      return status === 'running' ? 1_000 : false;
    },
  });
}

/** How long Phase 2 keeps polling before declaring the wait itself failed.
 *  A transient `not_serving_reason` while the listener comes up must not
 *  latch (PR 4 review, C4) — `failed` is advisory DURING the window and
 *  terminal only once the deadline passes. */
export const PHASE2_DEADLINE_MS = 5 * 60 * 1000;

/**
 * The Phase-2 completion read. RE-ARMS the host-serve status poll: the
 * standing `useHostServeStatus` hook deliberately disarms after one
 * `{serving:false}` (most machines never host), so an enable job must
 * invalidate + poll explicitly or nothing ever re-polls (E1 review, PR 3
 * round, CORRECTION 6).
 */
export function useHostServePhase2(opts: {
  active: boolean;
  /** The job token — the per-attempt cache key. Keying by snapshot latched a
   *  previous attempt's verdict onto the next one (review C4). */
  token: string | null;
  /** `started_at` snapshot from the enable/disable response (pre-restart). */
  snapshot: string | null;
  /** Wall-clock start of this attempt (persisted with the run marker). */
  armedAt: number;
  /** 'enable' waits for serving+bound+restarted; 'disable' waits for not-serving+restarted. */
  direction: 'enable' | 'disable';
}) {
  const qc = useQueryClient();
  return useQuery<{ done: boolean; failed: string | null; timedOut: boolean }>({
    queryKey: ['host-admin-phase2', opts.direction, opts.token],
    enabled: opts.active && opts.token !== null,
    queryFn: async ({ signal }) => {
      const timedOut = Date.now() - opts.armedAt > PHASE2_DEADLINE_MS;
      const body = await fetchJson<HostServeStatusResponse & {
        overlay_listener_bound?: boolean | null;
        started_at?: string | null;
        not_serving_reason?: string;
      }>('/host-serve/status', { signal });
      // FAIL CLOSED on an unverifiable restart (review C3): the
      // discriminator exists precisely because `serving` alone can describe
      // the dying pre-restart process — a missing stamp on either side must
      // never count as "restarted".
      const restarted = typeof body.started_at === 'string'
        && opts.snapshot !== null
        && body.started_at !== opts.snapshot;
      if (opts.direction === 'enable') {
        if (body.serving && body.overlay_listener_bound === true && restarted) {
          void qc.invalidateQueries({ queryKey: HOST_SERVE_STATUS_KEY });
          return { done: true, failed: null, timedOut: false };
        }
        // Advisory while the window is open; polling CONTINUES — the host
        // may bind a second later. Terminal only via the deadline.
        if (restarted && !body.serving && body.not_serving_reason
          && body.not_serving_reason !== 'restart_pending') {
          return { done: false, failed: body.not_serving_reason, timedOut };
        }
        return { done: false, failed: null, timedOut };
      }
      if (!body.serving && restarted) {
        void qc.invalidateQueries({ queryKey: HOST_SERVE_STATUS_KEY });
        return { done: true, failed: null, timedOut: false };
      }
      return { done: false, failed: null, timedOut };
    },
    refetchInterval: (query) => {
      const d = query.state.data;
      return d?.done || d?.timedOut ? false : 2_000;
    },
  });
}
