/**
 * `myco config` for a joined project.
 *
 * Two tiers (docs/architecture/myco-2.0.md §7.8). **Deployment Settings** are
 * read from the Deployment over the member credential (`POST /members/settings`,
 * the same leaves the dashboard's Settings page reads, each URL value without
 * its userinfo, query and fragment); provider credentials live in the
 * Deployment's secret store and never reach that answer. They are
 * written in the dashboard, not here. **Machine Settings** (`MACHINE_SETTING_LEAVES`)
 * are held by the Deployment for this machine and set on the dashboard (#1393):
 * `get` reads them from the same answer, and `set` names the dashboard. The other
 * **Member Settings** have no owner the 2.0 member reads yet, so `get` says so and
 * `set` refuses rather than writing a value nothing honours; the 1.4 tiers are
 * never written from here.
 */
import { machineBlockOf } from '../member/machine-settings.js';
import { withoutCredentialFlag } from '../mcp/deployment-upstream.js';
import type { CredentialSource } from '../member/constants.js';
import { membershipProblem, openDeployment, type DeploymentHandle, type MemberVerbDeps } from './deployment-reader.js';

/** The §7.8 leaves whose tier is Member; `tests/cli/member-config.test.ts` holds this equal to the ledger. */
export const MEMBER_TIER_LEAVES = [
  'daemon.log_level', 'daemon.log_retention_days',
  'capture.transcript_paths', 'capture.plan_dirs', 'capture.auto_join_roots', 'capture.connect_roots',
  'symbionts', 'update.channel',
  'appearance.theme', 'appearance.mode', 'appearance.font', 'appearance.density',
] as const;

/**
 * The Member leaves a machine honours today: held by the Deployment per machine, set on the dashboard (Access ›
 * Runtimes › Settings), and cached by the machine at each session start (`member/machine-settings.ts`).
 */
export const MACHINE_SETTING_LEAVES: readonly string[] = ['capture.plan_dirs', 'capture.auto_join_roots', 'capture.connect_roots'];

/** The machine leaf written by connecting a repository, never set directly. */
const CONNECT_ROOTS_LEAF = 'capture.connect_roots';

/** Where a machine's settings are set: the dashboard's Access page, on this machine's runtime. */
const machineSettingsAt = (serverUrl: string | null): string =>
  `the dashboard${serverUrl === null ? '' : ` (${serverUrl}/access)`}, under Runtimes › Settings for this machine`;

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

async function readLeaves(deployment: DeploymentHandle, err: (line: string) => void): Promise<{ leaves: SettingsLeaf[]; machine: { leaves: Record<string, unknown> } | null } | null> {
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
  return { leaves: leaves as SettingsLeaf[], machine: machineBlockOf(answer.value.machine) };
}

const render = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/** Answer `config get|set` for a joined project. True when the verb answered. */
export async function run(args: readonly string[], source: CredentialSource, deps: MemberVerbDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const [sub, leaf, ...rest] = withoutCredentialFlag(args);

  if (sub === 'set') {
    if (leaf === undefined || rest.length !== 1) { err(USAGE); return false; }
    if (leaf === CONNECT_ROOTS_LEAF) {
      const deployment = await openDeployment(source, deps);
      err(`myco config: ${leaf} is set by connecting a repository from "Needs you"${deployment === null ? '' : ` on ${deployment.serverUrl}`}, or with \`myco member join\` in it; nothing sets it directly. Nothing was changed.`);
      return false;
    }
    if (MACHINE_SETTING_LEAVES.includes(leaf)) {
      const deployment = await openDeployment(source, deps);
      err(`myco config: ${leaf} is this machine's setting, set in ${machineSettingsAt(deployment?.serverUrl ?? null)}; this command only reads it. Nothing was changed.`);
      return false;
    }
    if (isMemberLeaf(leaf)) { err(`myco config: ${notHonoured(leaf)}`); return false; }
    const deployment = await openDeployment(source, deps);
    const where = deployment === null ? 'the dashboard' : `the dashboard (${deployment.serverUrl}/settings)`;
    err(`myco config: Deployment Settings are written in ${where}; this command only reads them. ${leaf} was not changed.`);
    return false;
  }
  if (sub !== 'get' || rest.length > 0) { err(USAGE); return false; }
  if (leaf !== undefined && isMemberLeaf(leaf) && !MACHINE_SETTING_LEAVES.includes(leaf)) { err(`myco config: ${notHonoured(leaf)}`); return false; }

  const problem = source === 'registry' ? membershipProblem(deps) : null;
  if (problem !== null) { err(`myco config: ${problem}`); return false; }
  const deployment = await openDeployment(source, deps);
  if (deployment === null) {
    err(`myco config: no member credential resolves for this project (--credential ${source}); the reason is above`);
    return false;
  }
  const answered = await readLeaves(deployment, err);
  if (answered === null) return false;
  const { leaves, machine } = answered;

  if (leaf !== undefined && MACHINE_SETTING_LEAVES.includes(leaf)) {
    out(machine === null ? '(this credential names no machine of its own)' : render(machine.leaves[leaf] ?? []));
    return true;
  }
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
  out(`=== Machine Settings (this machine; set in ${machineSettingsAt(deployment.serverUrl)}) ===`);
  for (const machineLeaf of MACHINE_SETTING_LEAVES) out(`  ${machineLeaf} = ${machine === null ? '(no machine of its own)' : JSON.stringify(machine.leaves[machineLeaf] ?? [])}`);
  out('');
  out(`=== Member Settings (this machine) ===`);
  out(`Not read by the 2.0 member yet (${MEMBER_SETTINGS_ISSUE}); these leaves have no effect for a joined project:`);
  for (const member of MEMBER_TIER_LEAVES) if (!MACHINE_SETTING_LEAVES.includes(member)) out(`  ${member}`);
  return true;
}
