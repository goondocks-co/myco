import { legacyHistoryByProject } from '@myco/member/legacy-ledger.js';
import { readCutoverState, sameLegacyStamp, isLegacyDeploymentEvidence, type CutoverState } from '@myco/member/legacy-migration.js';
import { deploymentKeyFor, deploymentUrl, listDeploymentMembershipsResult } from '@myco/member/registry.js';
import { planLegacyProjects, type LegacyDestination } from '@myco/member/legacy-placement.js';
import { readVaultContent } from '@myco/member/legacy-backup.js';
import { legacyVaultFiles } from '@myco/member/home-role.js';
import { legacyProjectNames, legacyRealpath, legacyVaultStamp } from '@myco/member/legacy-sources.js';
import { listLeftRepositories } from '@myco/member/auto-join.js';
import { defaultMycoHome } from '@myco/paths/home.js';

interface LegacyPlacement {
  projectId: string;
  vault: string;
  root: string | null;
  destination: LegacyDestination;
}

/** Local acceptance facts and retained Deployment proof identify earlier imports. */
function earlierHistory(home: string, state: CutoverState): Map<string, string[]> {
  const history = legacyHistoryByProject(home);
  const proven = (evidence: unknown) => isLegacyDeploymentEvidence(evidence)
    && [evidence.eventIds, evidence.sporeIds, evidence.lineageIds].every(ids => ids === undefined || ids.every(id => id.length > 0));
  const add = (projectId: string, key: string) => history.set(projectId, [...new Set([...(history.get(projectId) ?? []), key])]);
  for (const receipt of Object.values(state.migrations ?? {})) for (const [projectId, project] of Object.entries(receipt.projects)) {
    if (project.destination && 'key' in project.destination && proven(project.evidence)) add(projectId, project.destination.key);
    for (const [key, destination] of Object.entries(project.destinations ?? {})) if (proven(destination.evidence)) add(projectId, key);
  }
  return history;
}

/** Accepted imports on other Deployments are reported without contacting or changing them. */
export function legacyStrayHistoryLines(home: string, projects: readonly LegacyPlacement[], state: CutoverState = readCutoverState(home), history = earlierHistory(home, state)): string[] {
  if (history.size === 0) return [];
  const listing = listDeploymentMembershipsResult(home);
  if (!listing.readable || listing.unavailableEntries > 0) throw new Error('Deployment memberships could not all be read; restore access before checking earlier moves.');
  const memberships = listing.memberships;
  const joined = new Set(memberships.map(member => deploymentKeyFor(member.serverUrl)));
  const urls = memberships.map(member => member.serverUrl);
  for (const receipt of Object.values(state.migrations ?? {})) for (const project of Object.values(receipt.projects)) {
    if (project.destination && 'serverUrl' in project.destination) urls.push(project.destination.serverUrl);
    urls.push(...Object.values(project.destinations ?? {}).map(destination => destination.serverUrl));
  }
  for (const repository of listLeftRepositories(home)) if (!('error' in repository) && repository.serverUrl) urls.push(repository.serverUrl);
  const addresses = new Map(urls.map(url => [deploymentKeyFor(url), deploymentUrl(url)]));
  const names = legacyProjectNames(projects);
  const lines = new Set<string>();
  for (const project of projects) {
    const destination = 'serverUrl' in project.destination ? project.destination.serverUrl : undefined;
    if (destination === undefined) continue;
    for (const key of history.get(project.projectId) ?? []) {
      if (key === deploymentKeyFor(destination)) continue;
      const address = addresses.get(key) ?? `Deployment ${key} (its address is no longer saved on this machine)`;
      lines.add(`An earlier move also put ${names.get(project.projectId)}'s history on ${address} (it now goes to ${deploymentUrl(destination)}). Myco leaves that copy alone; you can remove it from that Deployment.${joined.has(key) ? '' : ' This machine no longer belongs to that Deployment.'}`);
    }
  }
  return [...lines];
}

/** Status uses the cutover placement resolver for the same local-ledger report. */
export function observeLegacyStrayHistory(home: string, options: { homeDir?: string; homes?: readonly string[] } = {}): string[] {
  const state = readCutoverState(home);
  const history = earlierHistory(home, state);
  if (history.size === 0) return [];
  const homes = [...new Set([home, ...(options.homes ?? [defaultMycoHome(options.homeDir)]), ...(state.handover?.legacyHomes ?? [])])];
  const vaults = [...new Set(homes.flatMap(legacyVaultFiles).map(legacyRealpath))].map(vault => {
    const receipt = Object.entries(state.migrations ?? {}).find(([file]) => legacyRealpath(file) === vault)?.[1];
    const digest = receipt === undefined ? '' : sameLegacyStamp(legacyVaultStamp(vault), receipt) ? receipt.digest : readVaultContent(vault).digest;
    return { vault, digest };
  });
  const { projects, issues } = planLegacyProjects(home, vaults, {}, state);
  const unreadable = issues.filter(issue => issue.kind === 'unavailable');
  if (unreadable.length > 0) throw new Error(unreadable.map(issue => issue.message).join('\n'));
  const blocked = new Set(issues.map(issue => issue.projectId));
  return legacyStrayHistoryLines(home, projects.filter(project => !blocked.has(project.projectId)), state, history);
}
