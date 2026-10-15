import fs from 'node:fs';
import { isSafeProjectRoot } from '@myco/project-root.js';
import { deploymentUrl, listDeploymentMemberships, readRegistryEntryResult, type DeploymentMembership } from '@myco/member/registry.js';
import { defaultMembership } from '@myco/member/default-deployment.js';
import { completedLegacyDestination, readCutoverState, type CutoverState } from '@myco/member/legacy-migration.js';
import { legacyProjectRoots } from '@myco/member/legacy-import.js';
import { legacyRealpath } from '@myco/member/legacy-sources.js';

export type LegacyDestination = { kind: 'destination' | 'moved'; serverUrl: string } | { kind: 'skip' | 'undecided' };
export interface LegacyPlacementOptions {
  serverUrl?: string;
  routes?: ReadonlyMap<string, string>;
  skips?: ReadonlySet<string>;
}

/** The Deployment this machine is signed in to, or why there is none. */
function membershipFor(mycoHome: string, serverUrl: string | undefined): DeploymentMembership | string {
  const memberships = listDeploymentMemberships(mycoHome);
  if (serverUrl !== undefined) {
    return memberships.find((m) => deploymentUrl(m.serverUrl) === deploymentUrl(serverUrl)) ?? `this machine is not signed in to ${serverUrl}; run \`myco login\` first`;
  }
  const fallback = defaultMembership(mycoHome);
  if (fallback !== null) return fallback;
  if (memberships.length === 1) return memberships[0];
  return memberships.length === 0 ? 'this machine is not signed in to a Deployment; run `myco login` first' : `this machine belongs to ${memberships.length} Deployments; name one with --server`;
}

export const repositoryPresent = (root: string | null): root is string =>
  root !== null && fs.existsSync(root) && isSafeProjectRoot(root);

/** Resolve retained Projects through completed receipts, repository routes and explicit placement choices. */
export function planLegacyProjects(home: string, vaults: readonly { vault: string; digest: string }[], options: LegacyPlacementOptions = {}, state: CutoverState = readCutoverState(home)) {
  const issues: { projectId: string; message: string; kind: 'choice' | 'unavailable' }[] = [];
  const refuse = (projectId: string, message: string, kind: 'choice' | 'unavailable' = 'choice') => issues.push({ projectId, message, kind });
  const memberships = listDeploymentMemberships(home);
  const fallback = membershipFor(home, options.serverUrl);
  const vaultDigests = new Map(vaults.map(source => [source.vault, source.digest]));
  const projects = legacyProjectRoots(vaults.map((v) => v.vault)).map((project) => {
    const { projectId, root, vault } = project;
    const receipt = Object.entries(state.migrations ?? {}).find(([file]) => legacyRealpath(file) === vault)?.[1];
    const previous = receipt?.projects[projectId];
    const held = previous?.destination;
    const route = options.routes?.get(projectId);
    const skip = options.skips?.has(projectId) || (route === undefined && held !== undefined && 'skip' in held);
    if (skip && route !== undefined) refuse(projectId, `${projectId}: choose exactly one of --route or --skip`);
    if (skip) return { ...project, destination: { kind: 'skip' } as LegacyDestination };
    const completed = receipt !== undefined && previous !== undefined && receipt.digest === vaultDigests.get(vault)
      ? completedLegacyDestination(receipt, previous) : null;
    if (completed !== null && (route === undefined || deploymentUrl(route) === completed)) return { ...project, destination: { kind: 'moved', serverUrl: completed } as LegacyDestination };
    const binding = root === null ? null : readRegistryEntryResult(root, home);
    if (binding?.status === 'unavailable') refuse(projectId, `${projectId}: the binding at ${root} is unreadable; restore it before cutover`, 'unavailable');
    const foreignProject = binding?.status === 'present' && binding.entry.projectId !== projectId;
    const boundUrl = binding?.status === 'present' && !foreignProject ? deploymentUrl(binding.entry.serverUrl) : undefined;
    if (route !== undefined && boundUrl !== undefined && deploymentUrl(route) !== boundUrl) refuse(projectId, `${projectId}: ${root} routes to ${boundUrl}, so cutover cannot send it to ${route}; review the repository binding first`);
    const heldUrl = held !== undefined && 'serverUrl' in held ? held.serverUrl : undefined;
    if (heldUrl !== undefined && boundUrl !== undefined && heldUrl !== boundUrl && route === undefined) refuse(projectId, `${projectId}: its receipt names ${heldUrl} but its repository now routes to ${boundUrl}; confirm with --route ${projectId}=${boundUrl} or --skip ${projectId}`);
    const routedUrl = boundUrl ?? (route === undefined ? heldUrl : deploymentUrl(route));
    const canFallback = !foreignProject && (options.serverUrl !== undefined || repositoryPresent(root));
    const serverUrl = routedUrl ?? (!canFallback || typeof fallback === 'string' ? undefined : deploymentUrl(fallback.serverUrl));
    if (serverUrl === undefined) {
      const reason = root !== null && fs.existsSync(root) && !repositoryPresent(root) ? `${root} is not a repository; no destination` : 'no destination';
      refuse(projectId, `${projectId}: ${reason}; use --route ${projectId}=<url> or --skip ${projectId}`);
      return { ...project, destination: { kind: 'undecided' } as LegacyDestination };
    }
    if (!memberships.some((m) => deploymentUrl(m.serverUrl) === serverUrl)) refuse(projectId, `${projectId}: not signed in to ${serverUrl}; run myco login ${serverUrl}`);
    return { ...project, destination: { kind: 'destination', serverUrl } as LegacyDestination,
      ...(routedUrl === undefined ? { fallback: options.serverUrl === undefined ? 'default' as const : 'server' as const } : {}) };
  });
  const ids = new Set(projects.map(project => project.projectId));
  for (const id of [...(options.routes?.keys() ?? []), ...(options.skips ?? [])]) if (!ids.has(id)) refuse(id, `${id}: no such project in the 1.4 vaults`);
  for (const id of ids) {
    const urls = new Set(projects.filter(project => project.projectId === id && project.destination.kind === 'destination').map(project => project.destination.kind === 'destination' ? project.destination.serverUrl : ''));
    if (urls.size > 1) refuse(id, `${id}: its repositories route to different Deployments; resolve their bindings before cutover`);
  }
  return { projects, memberships, fallback, blockers: issues.map(issue => issue.message), issues };
}
