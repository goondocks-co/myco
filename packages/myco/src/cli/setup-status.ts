import { LEGACY_DESTINATION_HINT, legacyConfirmationHint } from './legacy-capture.js';
import os from 'node:os';
import path from 'node:path';
import type { Observation } from '@myco/setup/observe.js';

const labels: Record<string, string> = {
  legacy: '1.4 migration', journey: 'Setup', default: 'Default Deployment',
  'machine.signin': 'Signed in', 'machine.credential': 'Sign-in credential',
  'machine.agents': 'Agent hooks', project: 'Repository',
  'deployment.health': 'Deployment', 'deployment.signin': 'GitHub sign-in',
  'deployment.create': 'Deployment creation', 'deployment.owner': 'Owner account', 'deployment.serving': 'Serving',
  'runner.choice': 'Runner', 'runner.enrollment': 'Runner',
  'runner.service.choice': 'Runner start at login', 'runner.service': 'Runner service',
  'runner.offer': 'Runner agents', 'runner.authority': 'Runner authority',
  'machine.backlog': 'Capture', 'machine.latch': 'Capture hold-off', 'machine.refusals': 'Capture refusals',
};
const captureIds = new Set(['machine.backlog', 'machine.latch', 'machine.refusals']);
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const sentence = (detail: string): string => detail.trim().replace(/[.]+$/, '');
const shortPath = (value: string): string => {
  const home = process.env.HOME ?? os.homedir();
  return value.startsWith(home + '/') ? '~' + value.slice(home.length) : value;
};
const withoutHint = (detail: string): string => detail.split(/\. Run | Run |run \x60/)[0].trim();

const legacySentences: Record<string, string> = {
  unmoved: 'Myco 1.4 data has not been moved; run myco setup --cutover to preview and move it.',
  'needs-destination': 'Run myco setup --cutover to confirm each project destination, or preview manually with myco cutover --dry-run.',
  'handover-pending': 'Myco 1.4 capture has not handed over; run myco setup --cutover to preview the handover.',
  partial: 'Some Myco 1.4 data has not finished moving; run myco setup --cutover to preview and resume what remains.',
  changed: 'Myco 1.4 wrote more data after migration. Keep its files and run myco setup --cutover to review the new data.',
  moved: 'Myco 1.4 data has been moved.',
  unavailable: 'Myco 1.4 migration records could not be read; run myco setup --cutover to inspect them.',
};
function legacyState(fact: Observation): string { return fact.detail.match(/^[a-z-]+/)?.[0] ?? 'unavailable'; }

type StatusObservation = Observation & { agentHealth?: boolean };

function describe(fact: StatusObservation, url: string | undefined): string {
  const complete = fact.state === 'complete';
  const address = url ?? '<address>';
  if (fact.id === 'legacy') {
    const state = legacyState(fact);
    if (state === 'unavailable') return `Myco 1.4 migration records could not be read: ${sentence(fact.legacyError ?? fact.detail.replace(/^unavailable\s*/, ''))}. Inspect ${shortPath(fact.scope)}, then run myco setup --cutover.`;
    const confirmationHint = legacyConfirmationHint(fact.legacyConfirmation, fact.legacyConfirmationProjects);
    if (confirmationHint !== null) return confirmationHint;
    if (state === 'needs-destination' && fact.state === 'incomplete') return LEGACY_DESTINATION_HINT;
    return [legacySentences[state] ?? legacySentences.unavailable, fact.legacyNotice].filter(Boolean).join(' ');
  }
  if (fact.state === 'unavailable') return `Could not read ${labels[fact.id] ?? 'this observation'}: ${sentence(fact.detail)}. Inspect with ${fact.id.startsWith('runner.') ? 'myco runner status' : 'myco doctor'}.`;
  if (fact.id === 'runner.choice' && complete) return fact.detail === 'run-work' ? "This machine also runs Myco's work." : "This machine does not run Myco's work.";
  if (fact.id === 'runner.service.choice' && complete) return fact.detail === 'skip' ? 'Start at login declined.' : 'Start at login selected.';
  const joinSetup = 'myco setup --join <address>'.replace('<address>', address);
  const setup = fact.id.startsWith('runner.') ? 'myco setup --runner <address>'.replace('<address>', address) : joinSetup;
  if (fact.id === 'journey') return complete ? fact.detail === 'create' ? 'This machine manages this Deployment.' : fact.detail === 'join' ? 'This machine joins this Deployment.' : 'This machine runs work for this Deployment.' : fact.detail;
  if (fact.target && ['deployment.create', 'deployment.owner', 'deployment.serving', 'deployment.signin'].includes(fact.id)) {
    return fact.informational ? fact.detail : complete ? sentence(fact.detail) + '.' : `${sentence(fact.detail)}. Run myco setup --create ${fact.target}.`;
  }
  if (fact.id === 'default' && fact.state === 'absent') return `Not selected. New repositories will not automatically join a Deployment. Run myco login --default ${address} (approves this machine again).`;
  if (fact.id === 'default' && complete) return `${fact.detail} — new repositories join it.`;
  if (fact.id === 'machine.signin') return complete ? 'This machine is signed in (remote authentication not checked).' : `${sentence(fact.detail)}. Run myco login ${address}.`;
  if (fact.id === 'machine.agents' && fact.agentHealth) return fact.detail;
  if (fact.id === 'machine.agents') {
    if (fact.staleTools?.length) return `Capture is set up. ${fact.staleTools.join(' ')}`;
    if (fact.detail === 'legacy-hooks') return 'Myco 1.4 still captures your agents; run myco setup --cutover to hand over.';
    const capture = fact.memberCapture ? 'Myco 2.0 capture is installed. ' : '';
    if (complete) return fact.detail === 'current'
      ? fact.memberCapture ? `Myco 2.0 capture is installed for ${fact.hooksDeployment ?? address}.` : `set up for ${fact.hooksDeployment ?? address}`
      : fact.detail === 'declined' ? 'Setup declined.' : 'No supported agents installed.';
    return capture + (fact.state === 'absent' ? `Not set up; run myco member provision --server ${address}.` : 'Out of date; run myco member provision --refresh.');
  }
  if (fact.id === 'project') {
    if (fact.detail.startsWith('bound-cutover: ')) return `${shortPath(fact.scope)}: sends to ${fact.detail.slice('bound-cutover: '.length)} (cutover destination).`;
    if (fact.detail === 'bound-here') return `${shortPath(fact.scope)}: bound here.`;
    if (fact.detail.startsWith('bound-elsewhere:') && fact.informational) return `${shortPath(fact.scope)}: sends to ${fact.detail.slice('bound-elsewhere: '.length)}.`;
    if (fact.detail.startsWith('bound-elsewhere:')) return `${shortPath(fact.scope)}: bound elsewhere (${fact.detail.slice('bound-elsewhere: '.length)}). Run myco member join ${address} --root ${quote(fact.scope)} --project <id> to change it.`;
    if (!complete && fact.scope === url) return 'No repositories send to this Deployment yet. Run myco member join from a repository.';
    if (!complete) return `${shortPath(fact.scope)}: ${sentence(fact.detail)}. Run myco member join ${address} --project <id> --root <repository>.`;
  }
  if (fact.id === 'runner.choice' && !complete) return `Whether this machine runs Myco's work has not been chosen. Run ${joinSetup} --run-work or --no-runner.`;
  if (captureIds.has(fact.id)) {
    const command = fact.id === 'machine.refusals' ? 'myco logs' : 'myco member drain';
    return `${withoutHint(fact.detail)}. Run cd ${quote(fact.scope)} && ${command}.`;
  }
  if (complete && fact.id === 'runner.offer' && fact.detail.startsWith('Service declined;')) return 'Service declined.';
  if (complete) return withoutHint(fact.detail);
  if (fact.id === 'runner.enrollment') return `${fact.detail === 'pending' ? 'Registration approval is pending' : 'This machine is not registered as a runner'}. Run ${setup}.`;
  const explanation = fact.id === 'runner.service.choice' ? 'Whether the runner starts at login has not been chosen'
    : fact.id === 'runner.offer' ? fact.detail === 'historical' ? 'The saved agent offer predates the current runner service' : fact.detail === 'none' ? 'No agent offer has been recorded by this runner' : fact.detail
    : fact.detail;
  return `${sentence(withoutHint(explanation))}. Run ${fact.id === 'runner.authority' ? 'myco runner status' : setup}.`;
}


const plural = (count: number, noun: string): string => `${count} ${count === 1 ? noun : noun === 'repository' ? 'repositories' : noun + 's'}`;

/** Human status separates home-wide observations from Deployment capture and membership. */
export function renderSetupStatus(facts: readonly StatusObservation[]): string[] {
  const lines: string[] = [];
  const groups = new Map<string | undefined, StatusObservation[]>();
  const homeIds = new Set(['legacy', 'default', 'machine.agents']);
  const homeFacts = facts.filter(fact => homeIds.has(fact.id));
  const defaultUrl = homeFacts.find(fact => fact.id === 'default' && fact.state === 'complete')?.detail;
  const addresses = [...new Set(homeFacts.find(fact => fact.id === 'default')?.joinedDeployments ?? facts.filter(fact => fact.id === 'journey' && fact.detail === 'join').map(fact => fact.deployment).filter((url): url is string => url !== undefined))].sort();
  for (const fact of homeFacts) {
    if (fact.id === 'legacy' && legacyState(fact) === 'none') continue;
    const detail = fact.id === 'default' && fact.state === 'absent'
      ? `Not selected. New repositories will not automatically join a Deployment.${addresses.length ? ` Joined: ${addresses.join(', ')}.` : ''} Choose one with myco login --default <address> (approves this machine again).`
      : describe(fact, fact.hooksDeployment);
    lines.push(`${labels[fact.id]}: ${detail}`);
    lines.push(...fact.agentOffers ?? []);
  }
  for (const fact of facts.filter(fact => !homeIds.has(fact.id))) {
    groups.set(fact.deployment, [...(groups.get(fact.deployment) ?? []), fact]);
  }
  const ordered = [...groups].sort(([a], [b]) => a === b ? 0 : a === defaultUrl ? -1 : b === defaultUrl ? 1 : (a ?? '').localeCompare(b ?? ''));
  for (const [url, group] of ordered) {
    if (url) lines.push(`Deployment ${url}`);
    const serviceDeclined = group.some(fact => fact.id === 'runner.service.choice' && fact.state === 'complete' && fact.detail === 'skip');
    let setupPrinted = false;
    for (const fact of group) {
      if (fact.id === 'journey') {
        if (setupPrinted) continue;
        setupPrinted = true;
        const roles = group.filter(candidate => candidate.id === 'journey').map(candidate => candidate.detail);
        const detail = roles.includes('join') && roles.includes('runner') ? 'This machine joins and runs work for this Deployment.' : describe(fact, url);
        lines.push(`  Setup: ${detail}`);
        continue;
      }
      if (serviceDeclined && fact.state === 'complete') {
        if (fact.id === 'runner.service.choice') {
          lines.push(`  Runner start at login: Declined. Run myco runner run --server ${url ?? '<address>'} when ready.`);
          continue;
        }
        if (fact.id === 'runner.service' && fact.detail === 'declined' || fact.id === 'runner.offer' && fact.detail.startsWith('Service declined;')) continue;
      }
      if (fact.id === 'runner.choice' && (fact.detail === 'unasked' && !group.some(candidate => candidate.id === 'runner.enrollment') || group.some(candidate => candidate.id === 'runner.enrollment' && candidate.state === 'complete'))) continue;
      if (captureIds.has(fact.id) || (fact.id === 'project' && fact.informational && fact.detail.startsWith('bound-elsewhere:'))) continue;
      lines.push(`  ${labels[fact.id] ?? fact.id}: ${describe(fact, url)}`);
    }
    const captures = group.filter(fact => captureIds.has(fact.id));
    const repositories = new Set(captures.filter(fact => fact.id === 'machine.backlog' && fact.scope !== url).map(fact => fact.scope));
    if (repositories.size === 0) {
      if (captures.some(fact => fact.id === 'machine.backlog' && fact.state === 'complete') && !group.some(fact => fact.id === 'project' && fact.state === 'absent' && fact.scope === url)) lines.push('  Capture: No repositories send to this Deployment yet. Run myco member join from a repository.');
      for (const fact of captures.filter(fact => fact.state !== 'complete')) lines.push(`  Capture: ${describe(fact, url)}`);
      continue;
    }
    const problems = captures.filter(fact => fact.state !== 'complete');
    const affected = new Set(problems.map(fact => fact.scope));
    lines.push(`  Capture: ${plural(repositories.size, 'repository')}: ${problems.length === 0 ? 'nothing waiting' : `${repositories.size - affected.size} with nothing waiting; ${affected.size} ${affected.size === 1 ? 'needs' : 'need'} attention`}.`);
    for (const root of affected) {
      const rows = problems.filter(fact => fact.scope === root);
      const details = rows.map(fact => {
        if (fact.state === 'unavailable') return sentence(describe(fact, url));
        if (fact.id === 'machine.backlog' && fact.capture?.waiting !== undefined && fact.capture.waiting !== null) return `${plural(fact.capture.waiting, 'event')} waiting`;
        if (fact.id === 'machine.latch' && fact.capture?.nextProbeAt !== undefined) return `delivery paused until ${new Date(fact.capture.nextProbeAt).toISOString()}`;
        if (fact.id === 'machine.refusals' && fact.capture) return [
          fact.capture.recentRefusals ? `${plural(fact.capture.recentRefusals, 'refused event')} in the last 7 days, refused by your Myco server` : '',
          fact.capture.unreadableLines ? plural(fact.capture.unreadableLines, 'unreadable log line') : '',
        ].filter(Boolean).join('; ');
        return sentence(withoutHint(fact.detail));
      });
      const commands = [...new Set(rows.filter(fact => fact.state !== 'unavailable').map(fact => fact.id === 'machine.refusals' ? 'myco logs' : 'myco member drain'))];
      const displayPath = shortPath(root);
      const cd = displayPath.startsWith('~/') ? '~/' + quote(displayPath.slice(2)) : quote(displayPath);
      lines.push(`    ${path.basename(root)}: ${details.join('; ')}.${commands.length ? ` Run: cd ${cd} && ${commands.join(' && ')}.` : ` Repository: ${displayPath}.`}`);
    }
  }
  return lines;
}
