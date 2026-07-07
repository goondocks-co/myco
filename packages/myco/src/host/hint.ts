/**
 * Team Host affiliation hint — prompt-only guidance carried in the
 * committed `project.toml`.
 *
 * The existing optional `grove.remote { provider, remote_id }` block (see
 * `config/project-manifest.ts`, already covered by `assertNoSecretLikeKeys`)
 * doubles as a non-secret, portable hint: `provider: 'team-host'` +
 * `remote_id: <host_id>` tells a machine that has cloned this checkout
 * "this project is served by Team Host <host_id>". It never grants access,
 * never attaches, and never joins on its own — it exists purely to prompt
 * the user toward `myco join` + attach instead of silently letting the
 * project accumulate LOCAL Grove state it was never meant to have.
 *
 * The real routing decision (`resolveAttach`) and the never-materialize
 * invariant (`resolveAttachForProjectRoot`, `grove/registry.ts`) never read
 * this hint — they key off the machine-global attach registry only.
 *
 * Two consumers, one shared classification (`resolveTeamHostHintState` +
 * `teamHostHintMessage`):
 *   - `noticeTeamHostHintOnce`, called from `ensureProjectRegistered`'s
 *     cold path (`grove/registry.ts`) — the ONE moment a hinted project
 *     would otherwise silently get a local Grove registration. This is the
 *     seam that actually fires for a fresh checkout: `myco init` no longer
 *     exists (global install auto-registers on first agent hook), so this
 *     is the only place guaranteed to run before local state accumulates.
 *   - `checkTeamHostHint` (`cli/doctor.ts`) — the same guidance, on demand,
 *     as a `myco doctor` row for anyone who wants to check status directly.
 */
import type { ProjectManifest } from '../config/project-manifest.js';
import { getHost, resolveAttach } from './registry.js';

/** The `grove.remote.provider` value that marks a Team Host affiliation hint. */
export const TEAM_HOST_HINT_PROVIDER = 'team-host';

export interface TeamHostHint {
  host_id: string;
}

/**
 * Read the Team Host hint off an already-loaded project manifest, or null
 * when the manifest carries no `grove.remote` block, the block names a
 * different provider, or `remote_id` is missing.
 */
export function teamHostHintFromManifest(
  manifest: ProjectManifest | null | undefined,
): TeamHostHint | null {
  const remote = manifest?.grove?.remote;
  if (!remote || remote.provider !== TEAM_HOST_HINT_PROVIDER || !remote.remote_id) return null;
  return { host_id: remote.remote_id };
}

export type TeamHostHintState =
  | { kind: 'none' }
  | { kind: 'resolved' }
  | { kind: 'not_joined'; hostId: string }
  | { kind: 'not_attached'; hostId: string };

/**
 * Classify a project's Team Host hint against this machine's ACTUAL state —
 * the machine-global host registry (`getHost`) and attach registry
 * (`resolveAttach`). Pure disk reads, no side effects, no writes.
 *
 *   - `none`: no hint at all — nothing to report.
 *   - `resolved`: hint present AND the project is actually attached —
 *     normal routing already applies; nothing to report.
 *   - `not_joined`: hint present, but this machine hasn't joined the
 *     named host.
 *   - `not_attached`: hint present, host is joined, but this project
 *     hasn't been attached yet.
 */
export function resolveTeamHostHintState(
  manifest: ProjectManifest | null | undefined,
  projectId: string | null | undefined,
): TeamHostHintState {
  const hint = teamHostHintFromManifest(manifest);
  if (!hint) return { kind: 'none' };
  if (projectId && resolveAttach(projectId)) return { kind: 'resolved' };
  return getHost(hint.host_id)
    ? { kind: 'not_attached', hostId: hint.host_id }
    : { kind: 'not_joined', hostId: hint.host_id };
}

/** Human-readable guidance for a state, or null when there's nothing actionable to say. */
export function teamHostHintMessage(state: TeamHostHintState): string | null {
  switch (state.kind) {
    case 'not_joined':
      return `This project is served by Team Host ${state.hostId} — run \`myco join ${state.hostId}\` to enroll this machine, then attach this project.`;
    case 'not_attached':
      return `This project is served by Team Host ${state.hostId} (already joined) — attach this project to route it through the host.`;
    case 'resolved':
    case 'none':
      return null;
  }
}

/** Host ids already notified in this process. See `noticeTeamHostHintOnce`. */
const noticedHosts = new Set<string>();

/**
 * Print the Team Host hint guidance to stderr, once per host id. Intended
 * to be called from `ensureProjectRegistered`'s cold (first-ever
 * registration) path, which by construction runs at most once per project
 * per machine — every later hook call finds the project already registered
 * and short-circuits before reaching this call, so no cross-process dedup
 * store is needed for the common case. The in-memory Set additionally
 * guards the narrow same-process-burst race (e.g. concurrent hook
 * invocations racing the first registration).
 *
 * Never blocks the registration it warns about, never joins, never
 * attaches — purely observational.
 */
export function noticeTeamHostHintOnce(
  manifest: ProjectManifest | null | undefined,
  projectId: string | null | undefined,
): void {
  const state = resolveTeamHostHintState(manifest, projectId);
  const message = teamHostHintMessage(state);
  if (!message) return;
  const hostId = state.kind === 'not_joined' || state.kind === 'not_attached' ? state.hostId : '';
  if (noticedHosts.has(hostId)) return;
  noticedHosts.add(hostId);
  process.stderr.write(`[myco] ${message}\n`);
}

/** Test seam only: reset the once-per-host notice de-dup. */
export function __resetTeamHostHintNoticeForTests(): void {
  noticedHosts.clear();
}
