/**
 * Team Host affiliation hint — prompt-only guidance carried in the
 * committed `project.toml`.
 *
 * The existing optional `grove.remote { provider, remote_id }` block (see
 * `config/project-manifest.ts`, already covered by `assertNoSecretLikeKeys`)
 * doubles as a non-secret, portable hint: `provider: 'team-host'` +
 * `remote_id: <host_id>` tells a machine that has cloned this checkout
 * "this project is served by Team Host <host_id>". It never grants access,
 * never attaches, and never joins on its own — it exists purely so a
 * fresh checkout can prompt the user toward `myco join` + attach instead of
 * silently registering a local Grove for a project meant to be hosted.
 *
 * The real routing decision (`resolveAttach`) and the never-materialize
 * invariant (`resolveAttachForProjectRoot`, `grove/registry.ts`) never read
 * this hint — they key off the machine-global attach registry only. This
 * hint is consumed solely by user-facing guidance (`myco doctor`, see
 * `cli/doctor.ts`'s `checkTeamHostHint`).
 */
import type { ProjectManifest } from '../config/project-manifest.js';

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
