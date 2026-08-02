import { useProjectSelection } from './use-project-selection';
import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';
import { hostedDegradedInfo } from '../lib/degrade';

export interface GitIdentity {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  author: string;
  author_email: string;
  head_sha: string;
}

/**
 * `GET /api/git/status` is `degrade`-stamped for attached (hosted) projects
 * (`host/routing.ts`) — every request against a hosted grove 409s. Left
 * unguarded, the default poll interval plus React Query's default retry-3
 * turned this into a console/network storm on every hosted project (observed
 * live in the PR-1 smoke — the "known /api/git/status 409 storm" the
 * degradation-UX work item names). Both knobs key off the SAME uniform
 * detector (`hostedDegradedInfo`) the rest of the degraded-route UI uses:
 * never retry the refusal, and stop polling once it's been seen — there is
 * nothing to observe again until the project's attach state itself changes
 * (a page reload / re-selection re-mounts the query).
 */
export function useGitIdentity() {
  // Probe-or-skip (E1 §5.4): `/git/status` is project-scoped, and on a
  // MACHINE-scoped page (Team, Machine, Logs, Groves…) there is no ambient
  // project selection — polling anyway produced a background error drumbeat
  // in the console on every such page, not just Team. No selection → no
  // query, and a later selection re-arms it (the key changes).
  const selection = useProjectSelection();
  return usePowerQuery<GitIdentity>({
    queryKey: ['git-identity'],
    queryFn: ({ signal }) => fetchJson<GitIdentity>('/git/status', { signal }),
    enabled: selection !== null,
    refetchInterval: (query) => (hostedDegradedInfo(query.state.error) ? false : POLL_INTERVALS.GIT_IDENTITY),
    retry: (failureCount, err) => (hostedDegradedInfo(err) ? false : failureCount < 3),
    pollCategory: 'standard',
  });
}

export function gitIdentityInitials(author: string | undefined): string {
  if (!author) return '?';
  const trimmed = author.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
}
