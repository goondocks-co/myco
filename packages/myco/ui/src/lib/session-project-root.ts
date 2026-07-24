import { basename } from './format';

/**
 * Whether `root` looks like a Team Host's *synthetic* project root — the
 * `<mycoHome>/groves/<grove>/hosted/<projectId>` path `hostedProjectRoot`
 * (`host/hosted-projects.ts`) stamps onto a hosted registry row. That path is
 * the host's own bookkeeping location; it never exists on the member's disk.
 * When the host forwards a session it carries this root verbatim, so a member
 * viewing that session would otherwise see the host's internal path instead of
 * the checkout it actually lives in.
 *
 * Pure shape match on the `groves/<grove>/hosted/` tail — the UI never
 * resolves the member's MYCO_HOME, and a false positive is harmless because
 * substitution only runs for a project already known to be attached. Both path
 * separators are accepted so a Windows-captured root is caught too.
 */
const HOSTED_ROOT_PATTERN = /(?:^|[/\\])groves[/\\][^/\\]+[/\\]hosted(?:[/\\]|$)/;

export function isHostedRootPath(root: string | null | undefined): boolean {
  return typeof root === 'string' && HOSTED_ROOT_PATTERN.test(root);
}

/** The membership ref matched on a session's project id (subset used here). */
export interface SessionProjectRootRef {
  root: string | null;
}

export interface DisplaySessionProjectRootInput {
  /** The project is served by a Team Host (its selection carries `attached`). */
  attached: boolean;
  /** The membership ref joined on the session's project id, if one matched. */
  ref: SessionProjectRootRef | undefined;
}

/**
 * The project path to show for a session's "Project" metadata row. For an
 * attached project whose captured `project_root` is a host synthetic path
 * (W2 leftover), swap in the member's own checkout path. Fallback chain:
 *
 *   1. the membership ref's local `root` — the member's real checkout path;
 *   2. else the project-id folder (`basename` of the synthetic path) — a
 *      legacy ref that carries no local root still reads better as its
 *      trailing id segment than as the full host bookkeeping path;
 *   3. else the captured value unchanged — no ref matched at all, so surface
 *      what was captured rather than hiding it.
 *
 * Every other case (a plain local project, or a root that isn't a synthetic
 * host path) renders exactly what was captured.
 */
export function displaySessionProjectRoot(
  projectRoot: string | null,
  { attached, ref }: DisplaySessionProjectRootInput,
): string | null {
  if (!projectRoot) return projectRoot;
  if (!attached || !isHostedRootPath(projectRoot)) return projectRoot;
  if (ref?.root) return ref.root;
  if (ref) return basename(projectRoot);
  return projectRoot;
}
