import { effectiveUpdateChannel } from '@myco/upgrade/check-cache.js';
import { automaticUpdatesEnabled } from '@myco/install/marker-reader.js';
import { setUpdatePreferences } from '@myco/member/automatic-update-state.js';
import { MACHINE_SETTING_SPECS, MACHINE_UPDATE_LEAVES, RELEASE_CHANNELS } from '@goondocks/myco-shared/member-protocol';
/**
 * `myco config` reads Deployment settings and this machine's settings. A release channel is also set locally;
 * capture settings are edited on My machines. Other Member leaves have no active reader and refuse writes.
 */
import { machineSettingsLocation } from '@goondocks/myco-shared/setup-guidance';
import { machineBlockOf } from '../member/machine-settings.js';
import { withoutCredentialFlag } from '../mcp/deployment-upstream.js';
import type { CredentialSource } from '../member/constants.js';
import { homeOf, membershipProblem, openDeployment, type DeploymentHandle, type MemberVerbDeps } from './deployment-reader.js';

/** The §7.8 leaves whose tier is Member; `tests/cli/member-config.test.ts` holds this equal to the ledger. */
export const MEMBER_TIER_LEAVES = [
  'capture.plan_dirs', 'capture.auto_join_roots', 'capture.connect_roots',
  'symbionts', 'update.channel', 'update.automatic',
  'appearance.theme', 'appearance.mode', 'appearance.font', 'appearance.density',
] as const;

/**
 * The Member leaves this machine honours. My machines edits capture folders and requests installation preferences;
 * the member caches capture folders and applies update requests when it reads its settings.
 */
export const MACHINE_SETTING_LEAVES: readonly string[] = [...Object.keys(MACHINE_SETTING_SPECS), ...MACHINE_UPDATE_LEAVES];

/** The machine leaf written by connecting a repository, never set directly. */
const CONNECT_ROOTS_LEAF = 'capture.connect_roots';

/** The issue that gives Member Settings an owner the member reads. */
export const MEMBER_SETTINGS_ISSUE = '#1393';

/** The member route that answers the Deployment's settings leaves. */
export const SETTINGS_READ_PATH = '/members/settings';

/** A leaf names a Member setting when it is one, or sits beneath one (`notifications.domains.x`). */
export const isMemberLeaf = (leaf: string): boolean =>
  MEMBER_TIER_LEAVES.some((member) => leaf === member || leaf.startsWith(`${member}.`));

const USAGE = 'Usage: myco config get [<leaf>]\n       myco config set update.channel <stable|beta|alpha>\nOther machine and Deployment settings are edited on the dashboard.';

export interface SettingsLeaf {
  leaf: string;
  configured: boolean;
  value: unknown;
  updatedAt: number | null;
  updatedBy: string | null;
  /** Where the leaf stands on the Deployment, and why, where the Deployment says. */
  state?: string;
  reason?: string | null;
  retired?: boolean;
}

/** The words a stored value the Deployment does not use carries beside it, or nothing. */
const standing = (l: SettingsLeaf): string =>
  l.configured && l.retired !== true && (l.state === 'invalid' || l.state === 'not-applicable') ? `  (${l.state === 'invalid' ? 'invalid' : 'not used here'}: ${l.reason ?? 'the Deployment does not use it'})` : '';

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
    if (leaf === 'update.channel') {
      if (!RELEASE_CHANNELS.includes(rest[0] as typeof RELEASE_CHANNELS[number])) { err(`myco config: update.channel was not saved; use ${RELEASE_CHANNELS.join(', ')}. Next call: myco config set update.channel stable`); return false; }
      setUpdatePreferences(homeOf(deps), { channel: rest[0] });
      out(`Release channel is ${rest[0]}.`);
      return true;
    }
    if (leaf === CONNECT_ROOTS_LEAF) {
      const deployment = await openDeployment(source, deps);
      err(`myco config: ${leaf} is set by connecting a repository from "Needs you"${deployment === null ? '' : ` on ${deployment.serverUrl}`}, or with \`myco member join\` in it; nothing sets it directly. Nothing was changed.`);
      return false;
    }
    if (MACHINE_SETTING_LEAVES.includes(leaf)) {
      const deployment = await openDeployment(source, deps);
      err(`myco config: ${leaf} is this machine's setting, set in ${machineSettingsLocation(deployment?.serverUrl ?? null)}; this command only reads it. Nothing was changed.`);
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

  if (leaf === 'update.channel' || leaf === 'update.automatic') {
    out(render(leaf === 'update.channel' ? effectiveUpdateChannel(homeOf(deps)) : automaticUpdatesEnabled(homeOf(deps))));
    return true;
  }
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
    if (standing(found) !== '') out(standing(found).trim());
    return true;
  }

  out(`=== Deployment Settings (${deployment.serverUrl}) ===`);
  for (const l of leaves) out(`${l.leaf} = ${l.configured ? JSON.stringify(l.value) : '(default)'}${standing(l)}`);
  out('');
  out(`=== Machine Settings (this machine; set in ${machineSettingsLocation(deployment.serverUrl)}) ===`);
  for (const machineLeaf of MACHINE_SETTING_LEAVES) out(`  ${machineLeaf} = ${machine === null ? '(no machine of its own)' : JSON.stringify(machineLeaf === 'update.channel' ? effectiveUpdateChannel(homeOf(deps)) : machineLeaf === 'update.automatic' ? automaticUpdatesEnabled(homeOf(deps)) : machine.leaves[machineLeaf] ?? [])}`);
  out('');
  out(`=== Member Settings (this machine) ===`);
  out(`Not read by the 2.0 member yet (${MEMBER_SETTINGS_ISSUE}); these leaves have no effect for a joined project:`);
  for (const member of MEMBER_TIER_LEAVES) if (!MACHINE_SETTING_LEAVES.includes(member)) out(`  ${member}`);
  return true;
}
