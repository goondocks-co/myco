/**
 * `myco config` for a joined project.
 *
 * Two tiers (docs/architecture/myco-2.0.md §7.8). **Deployment Settings** are
 * read from the Deployment over the member credential (`POST /members/settings`,
 * the same leaves the dashboard's Settings page reads, each URL value without
 * its userinfo, query and fragment); provider credentials live in the
 * Deployment's secret store and never reach that answer. They are
 * written in the dashboard, not here. **Member Settings** have no owner the 2.0
 * member reads yet (#1393), so `get` says so and `set` refuses rather than
 * writing a value nothing honours; the 1.4 tiers are never written from here.
 */
import { withoutCredentialFlag } from '../mcp/deployment-upstream.js';
import type { CredentialSource } from '../member/constants.js';
import { membershipProblem, openDeployment, type DeploymentHandle, type MemberVerbDeps } from './deployment-reader.js';

/** The §7.8 leaves whose tier is Member; `tests/cli/member-config.test.ts` holds this equal to the ledger. */
export const MEMBER_TIER_LEAVES = [
  'daemon.log_level', 'daemon.log_retention_days', 'daemon.stale_session_threshold_ms',
  'capture.transcript_paths', 'capture.plan_dirs', 'capture.ignore_plan_dirs_in_git', 'capture.artifact_extensions',
  'capture.buffer_max_events', 'capture.ignore.paths', 'capture.ignore.patterns',
  'notifications.domains', 'notifications.enabled', 'notifications.system_notifications', 'notifications.default_mode',
  'symbionts', 'update.channel',
  'appearance.theme', 'appearance.mode', 'appearance.font', 'appearance.density',
] as const;

/** The issue that gives Member Settings an owner the member reads. */
export const MEMBER_SETTINGS_ISSUE = '#1393';

/** The member route that answers the Deployment's settings leaves. */
export const SETTINGS_READ_PATH = '/members/settings';

/** A leaf names a Member setting when it is one, or sits beneath one (`notifications.domains.x`). */
export const isMemberLeaf = (leaf: string): boolean =>
  MEMBER_TIER_LEAVES.some((member) => leaf === member || leaf.startsWith(`${member}.`));

const USAGE = 'Usage: myco config get [<leaf>]\n       myco config set <leaf> <value>   (refused for a joined project: see below)';

export interface SettingsLeaf {
  leaf: string;
  configured: boolean;
  value: unknown;
  updatedAt: number | null;
  updatedBy: string | null;
}

const notHonoured = (leaf: string): string =>
  `${leaf} is a Member setting, and the 2.0 member does not read Member settings yet (${MEMBER_SETTINGS_ISSUE}); nothing is written for a joined project`;

async function readLeaves(deployment: DeploymentHandle, err: (line: string) => void): Promise<SettingsLeaf[] | null> {
  const answer = await deployment.post(SETTINGS_READ_PATH, {});
  if (!answer.ok) {
    err(`myco config: ${deployment.serverUrl} did not answer its settings (${answer.error.code}): ${answer.error.message}`);
    return null;
  }
  const leaves = answer.value.leaves;
  if (!Array.isArray(leaves)) {
    err(`myco config: ${deployment.serverUrl} answered its settings with no leaves`);
    return null;
  }
  return leaves as SettingsLeaf[];
}

const render = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/** Answer `config get|set` for a joined project. True when the verb answered. */
export async function run(args: readonly string[], source: CredentialSource, deps: MemberVerbDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const [sub, leaf, ...rest] = withoutCredentialFlag(args);

  if (sub === 'set') {
    if (leaf === undefined || rest.length !== 1) { err(USAGE); return false; }
    if (isMemberLeaf(leaf)) { err(`myco config: ${notHonoured(leaf)}`); return false; }
    const deployment = await openDeployment(source, deps);
    const where = deployment === null ? 'the dashboard' : `the dashboard (${deployment.serverUrl}/settings)`;
    err(`myco config: Deployment Settings are written in ${where}; this command only reads them. ${leaf} was not changed.`);
    return false;
  }
  if (sub !== 'get' || rest.length > 0) { err(USAGE); return false; }
  if (leaf !== undefined && isMemberLeaf(leaf)) { err(`myco config: ${notHonoured(leaf)}`); return false; }

  const problem = source === 'registry' ? membershipProblem(deps) : null;
  if (problem !== null) { err(`myco config: ${problem}`); return false; }
  const deployment = await openDeployment(source, deps);
  if (deployment === null) {
    err(`myco config: no member credential resolves for this project (--credential ${source}); the reason is above`);
    return false;
  }
  const leaves = await readLeaves(deployment, err);
  if (leaves === null) return false;

  if (leaf !== undefined) {
    const found = leaves.find((l) => l.leaf === leaf);
    if (found === undefined) {
      err(`myco config: ${leaf} is neither a Deployment setting ${deployment.serverUrl} serves nor a Member setting`);
      return false;
    }
    out(found.configured ? render(found.value) : '(not set; the Deployment default applies)');
    return true;
  }

  out(`=== Deployment Settings (${deployment.serverUrl}) ===`);
  for (const l of leaves) out(`${l.leaf} = ${l.configured ? JSON.stringify(l.value) : '(default)'}`);
  out('');
  out(`=== Member Settings (this machine) ===`);
  out(`Not read by the 2.0 member yet (${MEMBER_SETTINGS_ISSUE}); these leaves have no effect for a joined project:`);
  for (const member of MEMBER_TIER_LEAVES) out(`  ${member}`);
  return true;
}
