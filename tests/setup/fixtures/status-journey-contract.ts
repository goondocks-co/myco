import fs from 'node:fs';
import { observeSetup, type Observation, type ObserveDeps } from '@myco/setup/observe.js';
import type { SetupAnswers } from '@myco/setup/answers.js';
import { legacyConfirmationObserver } from '@myco/cli/cutover.js';
import { deploymentUrl, listDeploymentMembershipsResult } from '@myco/member/registry.js';
import { listRunnerRecordsResult } from '@myco/runner/runner-registry.js';
import { peekDeploymentRecord } from '@myco/server/cloudflare.js';
import { peekLocalPaths } from '@myco/server/local.js';

export async function observeStatusContract(home: string, answers: SetupAnswers, deps: ObserveDeps = {}, selected = false): Promise<Observation[]> {
  deps = { ...deps, legacyObserver: deps.legacyObserver ?? legacyConfirmationObserver() };
  const journeys: SetupAnswers[] = [];
  const failures: Observation[] = [];
  const unavailable = (id: string, detail: string): void => {
    failures.push({ id, scope: home, state: 'unavailable', detail });
  };
  const memberships = listDeploymentMembershipsResult(home);
  if (!memberships.readable || memberships.unavailableEntries > 0) unavailable('machine.signin', 'Deployment memberships could not all be read. Inspect the membership files with myco doctor.');
  const homeFact = (fact: Observation): Observation => fact.id === 'default'
    ? { ...fact, joinedDeployments: memberships.memberships.map(membership => deploymentUrl(membership.serverUrl)) } : fact;
  if (selected && answers.role && (answers.url || answers.role === 'create')) journeys.push(answers);
  else {
    try {
      const record = peekDeploymentRecord(home);
      if (record !== null) journeys.push({ role: 'create', target: 'cloudflare' });
    } catch (error) { unavailable('deployment.create', error instanceof Error ? error.message : String(error)); }
    try {
      if (fs.lstatSync(peekLocalPaths(home).root, { throwIfNoEntry: false }) !== undefined) journeys.push({ role: 'create', target: 'local' });
    } catch (error) { unavailable('deployment.create', error instanceof Error ? error.message : String(error)); }
    for (const membership of memberships.memberships) journeys.push({ role: 'join', url: deploymentUrl(membership.serverUrl) });
    const runners = listRunnerRecordsResult(home);
    for (const runner of runners.records) journeys.push({ role: 'runner', url: deploymentUrl(runner.serverUrl) });
    for (const error of runners.errors) unavailable('runner.enrollment', `Runner record could not be read: ${error}. Run myco runner status.`);
    if (answers.role && (answers.url || answers.role === 'create') && !journeys.some(journey => journey.role === answers.role && (answers.role === 'create' ? journey.target === answers.target : journey.url === answers.url))) journeys.push(answers);
  }
  if (journeys.length === 0) {
    const observed = await observeSetup(home, {}, { ...deps, status: true });
    return [...observed.filter(fact => failures.length === 0 || fact.id !== 'journey').map(homeFact), ...failures];
  }
  const facts: Observation[] = [];
  for (const journey of journeys) {
    const saved = journey.role === 'create'
      ? answers.role === 'create' && answers.target === journey.target ? answers : {}
      : answers.url === undefined || answers.url === journey.url ? answers : {};
    const scoped = { ...saved, ...journey, root: answers.root };
    const observed = await observeSetup(home, scoped, { ...deps, status: true });
    const address = journey.role === 'create' ? observed.find(fact => fact.id === 'machine.signin')?.scope : journey.url;
    for (const fact of observed) {
      const homeWide = ['legacy', 'default', 'machine.agents'].includes(fact.id);
      if (homeWide && facts.some(existing => existing.id === fact.id)) continue;
      if (facts.some(existing => existing.id === fact.id && existing.scope === fact.scope && existing.deployment === journey.url && fact.id.startsWith('runner.') && fact.id !== 'runner.choice')) continue;
      facts.push({ ...fact, ...(homeWide ? {} : { deployment: address }),
        ...(!selected && fact.id === 'project' && fact.detail.startsWith('bound-elsewhere:') ? { informational: true } : {}),
      });
    }
  }
  return [...facts.map(homeFact), ...failures];
}
