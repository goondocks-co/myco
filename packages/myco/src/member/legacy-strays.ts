import { createHash } from 'node:crypto';
import { legacyHistoryByProject, type LegacyHistory } from '@myco/member/legacy-ledger.js';
import { readCutoverState, sameLegacyStamp, isLegacyDeploymentEvidence, type CutoverState, type MigrationProjectReceipt } from '@myco/member/legacy-migration.js';
import { deploymentKeyFor, deploymentUrl, listDeploymentMembershipsResult } from '@myco/member/registry.js';
import { planLegacyProjects, type LegacyDestination } from '@myco/member/legacy-placement.js';
import { readVaultContent } from '@myco/member/legacy-backup.js';
import { legacyVaultFiles } from '@myco/member/home-role.js';
import { legacyProjectNames, legacyRealpath, legacyVaultStamp } from '@myco/member/legacy-sources.js';
import { listLeftRepositories } from '@myco/member/auto-join.js';
import { LegacyCopyAcknowledgements, type EarlierCopyCount } from '@myco/member/legacy-copy-acknowledgements.js';
import { defaultMycoHome } from '@myco/paths/home.js';

interface LegacyPlacement {
  projectId: string;
  vault: string;
  root: string | null;
  destination: LegacyDestination;
}

/** Local acceptance facts and retained Deployment proof identify earlier imports. */
function earlierHistory(home: string, state: CutoverState): LegacyHistory {
  const history = legacyHistoryByProject(home);
  const proven = (evidence: unknown): evidence is NonNullable<MigrationProjectReceipt['evidence']> => isLegacyDeploymentEvidence(evidence)
    && [evidence.eventIds, evidence.sporeIds, evidence.lineageIds].every(ids => ids === undefined || ids.every(id => id.length > 0));
  const add = (projectId: string, key: string, evidence: unknown) => {
    if (!proven(evidence)) return;
    const project = history.get(projectId) ?? new Map<string, Set<string>>();
    const records = project.get(key) ?? new Set<string>();
    for (const [kind, ids] of [['event', evidence.eventIds], ['spore', evidence.sporeIds ?? []], ['lineage', evidence.lineageIds ?? []]] as const) for (const id of ids) records.add(`${kind}:${id}`);
    project.set(key, records);
    history.set(projectId, project);
  };
  for (const receipt of Object.values(state.migrations ?? {})) for (const [projectId, project] of Object.entries(receipt.projects)) {
    if (project.destination && 'key' in project.destination) add(projectId, project.destination.key, project.evidence);
    for (const [key, destination] of Object.entries(project.destinations ?? {})) add(projectId, key, destination.evidence);
  }
  return history;
}

interface EarlierCopy extends EarlierCopyCount { name: string; address: string; line: string }

/** Accepted imports on other Deployments are reported without contacting or changing them. */
function earlierCopies(home: string, projects: readonly LegacyPlacement[], state: CutoverState, history: LegacyHistory): EarlierCopy[] {
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
  const acknowledgements = new LegacyCopyAcknowledgements(home).read();
  const copies = new Map<string, EarlierCopy>();
  for (const project of projects) {
    // A skipped project is not routed elsewhere.
    const destination = 'serverUrl' in project.destination ? project.destination.serverUrl : undefined;
    if (destination === undefined) continue;
    for (const [key, records] of history.get(project.projectId) ?? []) {
      const acknowledged = acknowledgements.projects[project.projectId]?.[key];
      const digest = createHash('sha256').update(JSON.stringify([...records].sort())).digest('hex');
      if (key === deploymentKeyFor(destination) || (records.size === acknowledged?.count && digest === acknowledged.digest)) continue;
      const savedAddress = addresses.get(key);
      const address = savedAddress ?? `a Deployment this machine has left (stored as ${key}; its address was not kept)`;
      const placement = savedAddress === undefined ? `. It now goes to ${deploymentUrl(destination)}.` : ` (it now goes to ${deploymentUrl(destination)}).`;
      const name = names.get(project.projectId)!;
      const line = `An earlier move also put ${name}'s history on ${address}${placement} Myco leaves that copy alone; you can remove it from that Deployment.${joined.has(key) || savedAddress === undefined ? '' : ' This machine no longer belongs to that Deployment.'} Run myco cutover --dismiss-earlier-copies once you have.`;
      copies.set(JSON.stringify([project.projectId, key]), { projectId: project.projectId, key, count: records.size, digest, name, address, line });
    }
  }
  return [...copies.values()];
}

export function legacyStrayHistoryLines(home: string, projects: readonly LegacyPlacement[], state: CutoverState = readCutoverState(home), history = earlierHistory(home, state)): string[] {
  return earlierCopies(home, projects, state, history).map(copy => copy.line);
}

interface ObservationOptions { homeDir?: string; homes?: readonly string[] }

/** Status and dismissal use the cutover placement resolver and local acceptance facts. */
function observeEarlierCopies(home: string, options: ObservationOptions): EarlierCopy[] {
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
  return earlierCopies(home, projects.filter(project => !blocked.has(project.projectId)), state, history);
}

export function observeLegacyStrayHistory(home: string, options: ObservationOptions = {}): string[] {
  return observeEarlierCopies(home, options).map(copy => copy.line);
}

/** Acknowledgement changes only the count-bound member record, never accepted-history evidence. */
export function dismissLegacyEarlierCopies(home: string, options: ObservationOptions = {}): string[] {
  return new LegacyCopyAcknowledgements(home).dismiss(() => observeEarlierCopies(home, options))
    .map(copy => `Dismissed the earlier copy of ${copy.name}'s history on ${copy.address}. More accepted history there will show it again.`);
}
