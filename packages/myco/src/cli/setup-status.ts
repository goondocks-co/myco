import type { Observation } from '@myco/setup/observe.js';

const labels: Record<string, string> = {
  legacy: '1.4 migration', journey: 'Setup', default: 'Default Deployment',
  'machine.signin': 'Signed in', 'machine.credential': 'Sign-in credential',
  'machine.agents': 'Agent hooks', project: 'Repository',
  'deployment.health': 'Deployment', 'deployment.signin': 'GitHub sign-in',
  'runner.choice': 'Runner', 'runner.enrollment': 'Runner',
  'runner.service.choice': 'Runner start at login', 'runner.service': 'Runner service',
  'runner.offer': 'Runner agents', 'runner.authority': 'Runner authority',
  'machine.backlog': 'Capture', 'machine.latch': 'Capture hold-off', 'machine.refusals': 'Capture refusals',
};
const captureIds = new Set(['machine.backlog', 'machine.latch', 'machine.refusals']);
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const withoutHint = (detail: string): string => detail.split(/\. Run | Run |run \x60/)[0].trim();

function describe(fact: Observation, url: string | undefined): string {
  const complete = fact.state === 'complete';
  const address = url ?? '<address>';
  if (fact.state === 'unavailable') return `Could not read ${labels[fact.id] ?? 'this observation'}: ${fact.detail}. Inspect with ${fact.id.startsWith('runner.') ? 'myco runner status' : 'myco doctor'}.`;
  if (fact.id === 'runner.choice' && complete) return fact.detail === 'run-work' ? "This machine also runs Myco's work." : "This machine does not run Myco's work.";
  if (fact.id === 'runner.service.choice' && complete) return fact.detail === 'skip' ? 'Start at login declined.' : 'Start at login selected.';
  const joinSetup = 'myco setup --join <address>'.replace('<address>', address);
  const setup = fact.id.startsWith('runner.') ? 'myco setup --runner <address>'.replace('<address>', address) : joinSetup;
  if (fact.id === 'journey') return complete ? fact.detail === 'join' ? 'This machine joins this Deployment.' : 'This machine runs work for this Deployment.' : fact.detail;
  if (fact.id === 'default' && fact.state === 'absent') return `Not selected. New repositories will not automatically join a Deployment. Run myco login --default ${address}.`;
  if (fact.id === 'default' && complete) return `${fact.detail} — new repositories join it.`;
  if (fact.id === 'machine.signin') return complete ? 'This machine is signed in (remote authentication not checked).' : `${fact.detail}. Run myco login ${address}.`;
  if (fact.id === 'machine.agents') {
    if (complete) return fact.detail === 'current' ? 'Current.' : fact.detail === 'declined' ? 'Setup declined.' : 'No supported agents installed.';
    if (fact.detail === 'deferred-legacy') return 'Myco 1.4 still owns agent capture. Preview the handover with myco cutover --dry-run.';
    return `${fact.detail === 'stale' ? 'Installed hooks, MCP registration, or skills do not match this Myco version and Deployment.' : fact.detail} Run myco member provision --server ${address}.`;
  }
  if (fact.id === 'project') {
    if (fact.detail === 'bound-here') return `${fact.scope}: bound here.`;
    if (fact.detail.startsWith('bound-elsewhere:') && fact.informational) return `${fact.scope}: sends to ${fact.detail.slice('bound-elsewhere: '.length)}.`;
    if (fact.detail.startsWith('bound-elsewhere:')) return `${fact.scope}: bound elsewhere (${fact.detail.slice('bound-elsewhere: '.length)}). Run myco member join ${address} --root ${quote(fact.scope)} --project <id> to change it.`;
    if (!complete) return `${fact.scope}: ${fact.detail}. Run myco member join ${address} --project <id> --root <repository>.`;
  }
  if (fact.id === 'runner.choice' && !complete) return `Whether this machine runs Myco's work has not been chosen. Run ${joinSetup} --run-work or --no-runner.`;
  if (captureIds.has(fact.id)) {
    const command = fact.id === 'machine.refusals' ? 'myco logs' : 'myco member drain';
    return `${withoutHint(fact.detail)}. Run cd ${quote(fact.scope)} && ${command}.`;
  }
  if (complete && fact.id === 'runner.offer' && fact.detail.startsWith('Service declined;')) return 'Service declined.';
  if (complete && fact.id === 'legacy') return withoutHint(fact.detail.replace(/^[a-z-]+ /, ''));
  if (complete) return withoutHint(fact.detail);
  if (fact.id === 'legacy') return `${fact.detail}${fact.hint && !fact.detail.includes(fact.hint) ? ` ${fact.hint}` : ''}`;
  if (fact.id === 'runner.enrollment') return `${fact.detail === 'pending' ? 'Registration approval is pending' : 'This machine is not registered as a runner'}. Run ${setup}.`;
  const explanation = fact.id === 'runner.service.choice' ? 'Whether the runner starts at login has not been chosen'
    : fact.id === 'runner.offer' ? fact.detail === 'historical' ? 'The saved agent offer predates the current runner service' : fact.detail === 'none' ? 'No agent offer has been recorded by this runner' : fact.detail
    : fact.detail;
  return `${withoutHint(explanation)}. Run ${fact.id === 'runner.authority' ? 'myco runner status' : setup}.`;
}

/** Human status groups file observations by Deployment and shows only actionable capture rows. */
export function renderSetupStatus(facts: readonly Observation[]): string[] {
  const lines: string[] = [];
  const groups = new Map<string | undefined, Observation[]>();
  for (const fact of facts) {
    const key = fact.deployment;
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  for (const [url, group] of groups) {
    if (url) lines.push(`Deployment ${url}`);
    for (const fact of group) {
      if (fact.id === 'runner.choice' && facts.some(candidate => candidate.id === 'runner.enrollment' && candidate.state === 'complete' && candidate.deployment === url)) continue;
      if (captureIds.has(fact.id) || (fact.id === 'runner.choice' && fact.detail === 'unasked' && !facts.some(candidate => candidate.id === 'runner.enrollment' && candidate.deployment === url))) continue;
      lines.push(`  ${labels[fact.id] ?? fact.id}: ${describe(fact, url)}`);
    }
    const captures = group.filter(fact => captureIds.has(fact.id));
    const repositories = new Set(captures.filter(fact => fact.id === 'machine.backlog' && fact.scope !== url).map(fact => fact.scope));
    if (repositories.size > 0) {
      const problems = captures.filter(fact => fact.state !== 'complete');
      const affected = new Set(problems.map(fact => fact.scope));
      lines.push(`  Capture: ${repositories.size} repositories: ${problems.length === 0 ? 'nothing waiting' : `${repositories.size - affected.size} with nothing waiting; ${affected.size} need attention`}.`);
      for (const fact of problems) lines.push(`    ${fact.scope} — ${labels[fact.id]}: ${describe(fact, url)}`);
    } else for (const fact of captures) lines.push(`  Capture: ${fact.state === 'complete' ? withoutHint(fact.detail) : describe(fact, url)}`);
  }
  return lines;
}
