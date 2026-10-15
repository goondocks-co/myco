/** Recovery words shared by the terminal and dashboard. */
export const LEGACY_AGENT_DEFERRAL = 'Agent setup is deferred because retained Myco 1.4 history has no complete migration receipt. Run myco setup --cutover to review and move it, or preview manually with myco cutover --dry-run.';
export const cutoverAbsentFolder = (projectId: string, root: string | null): string =>
  `${projectId}: folder ${root ?? '(not recorded)'} is absent or unsafe; vault history only. Use --map <dir>=<root> for retained transcripts.`;
export const cutoverForeignBinding = (projectId: string, root: string, boundTo: string, serverUrl: string): string =>
  `${projectId}: ${root} is bound to ${boundTo}; repository route and transcripts stay there. Vault history goes to ${serverUrl}.`;
export type CodexInstallationRule = 'root' | 'contains-home' | 'contains-run' | 'contains-temp' | 'overlaps-codex-login' | 'overlaps-myco-home' | 'overlaps-codex-home';
const CODEX_INSTALLATION_REASONS: Readonly<Record<CodexInstallationRule, string>> = {
  root: 'is the filesystem root',
  'contains-home': 'contains your home folder',
  'contains-run': 'contains the run folder',
  'contains-temp': 'contains a temporary folder',
  'overlaps-codex-login': "overlaps Codex's login folder",
  'overlaps-myco-home': "overlaps Myco's folder",
  'overlaps-codex-home': "overlaps the run's Codex home",
};
export const codexInstallationRefusal = (directory: string, rule: CodexInstallationRule): string =>
  `Myco won't run Codex from ${directory}: that folder ${CODEX_INSTALLATION_REASONS[rule]}, so a run could reach what it must not. Install Codex somewhere narrower (for example npm install -g @openai/codex), then check myco runner status.`;
export const DOCTOR_SIGN_IN = 'this machine has joined no Myco. Run `myco setup`.';
export const DOCTOR_REFUSED_HOOK_REPAIR = 'Run `myco member provision` to rewrite the hooks Myco installed; start a new agent session to check capture.';
export const OWNER_SETUP_COMMAND = 'myco setup';
export const OWNER_UNCLAIMED = `This Myco has no owner yet, so nobody can approve this machine. Whoever created it must run ${OWNER_SETUP_COMMAND} on the machine that created it, then open and complete the fresh owner link.`;
export const OWNER_LINK_DENIED = `This owner link has expired or was already used. On the machine that created this Myco, run ${OWNER_SETUP_COMMAND} again for a fresh link, then open and complete it.`;
export const SIGN_IN_UNCONFIGURED = (origin: string): string => `GitHub sign-in is not set up for this Myco (${origin}). On the machine that created it, run ${OWNER_SETUP_COMMAND} to finish sign-in, then reload this page. Manual path: myco server github-app --target local --url ${origin} for self-hosting, or myco server github-app --target cloudflare --url ${origin} for Cloudflare.`;
export const ACCOUNT_UNLINKED = 'Your GitHub account is not connected to a member of this Myco. Ask an owner or admin to connect it from People & machines, then open the link they send while signed in to this account.';
export const SIGN_IN_WAIT = 'If nobody approves within 10 minutes, this stops; the approval page says what is missing.';
export const SETUP_CREATE_GUIDANCE = {
  loopbackOnly: 'Guided local setup is loopback only. Keep this Myco’s configuration and use myco server status --target local.',
  addressMissing: 'Cloudflare has not reported your Myco’s address; run myco server status --target cloudflare, then myco setup again.',
  signInPending: 'GitHub sign-in is not answering yet; check myco server status --target cloudflare, then run myco setup again.',
  ownerPending: 'Owner linking is pending; run myco setup again when ready.',
  ownerExpired: 'Owner link expired; run myco setup again to make a fresh link.',
  ownerMissing: 'No owner link was issued; run myco server setup-owner, then myco setup again.',
} as const;
export const START_SLOW_DOWN = 'Too many requests. Wait a minute, then run the command again.';
export const RUNNER_NEEDS_ADMIN = 'Only the owner or an admin can register a runner. Ask one to open the approval page and approve your code, then run myco runner register again.';
export const DEVICE_MEMBERSHIP_REFUSAL = 'You cannot approve this request with your current membership. Ask the owner or an admin to approve a runner; sign in with your linked GitHub account to approve your own machine.';
export const DEVICE_CODE_REFUSAL = 'This code has expired, was already used, or does not match. Run myco login again for a machine code, or myco runner register for a runner code.';
export const LINK_REFUSALS: Readonly<Record<string, string>> = {
  owner_link_denied: OWNER_LINK_DENIED,
  link_denied: 'This link has expired or was already used. Ask whoever gave it to you for a fresh one, then open it.',
  identity_taken: 'This GitHub account is already connected to another member. Sign out and open this link with the GitHub account meant for it.',
  member_linked: 'That member already has a GitHub account connected. Ask the server operator to recover access to that account.',
  member_revoked: 'That membership is inactive. Ask an owner or admin to restore access, then ask for a fresh link.',
  link_requires_admin: ACCOUNT_UNLINKED,
};
export const noOwnerSignIn = (url: string): string => `${url} has no owner yet, so nobody can approve this machine. Whoever created it finishes with ${OWNER_SETUP_COMMAND} on the machine that created it, then run myco setup --join ${url}.`;

export const ownerLinkNext = (url: string, target: 'local' | 'cloudflare'): string =>
  `It expires in 15 minutes; run myco server setup-owner --target ${target} again for a fresh one.${target === 'local' ? ' Stop it first with Ctrl-C in its terminal, or myco server uninstall --target local; then start it with myco server install --target local.' : ''} Then on each machine you use: myco login ${new URL(url).origin}.`;
export const LOCAL_OWNER_NEXT = "While it's stopped: myco server setup-owner --target local. Then start it: myco server install --target local.";
export const toolsStayOnDeploymentGuidance = (agent: string, url: string): { problem: string; remedy: string } => ({
  problem: `${agent}'s Myco tools stay on ${url}; one machine can't point them at two Mycos yet. Capture goes to the right one.`,
  remedy: 'Run myco doctor from this repository to check capture.',
});
export const toolsStayOnDeployment = (agent: string, url: string): string => {
  const { problem, remedy } = toolsStayOnDeploymentGuidance(agent, url);
  return `${problem} ${remedy}`;
};
export const runnerCheckIn = (offered: readonly string[], withheld: readonly string[], at: number): string =>
  `Checked in: offering ${offered.join(', ') || 'none'}; unavailable: ${withheld.join(', ') || 'none'} (checked ${new Date(at).toISOString()}).${offered.length === 0 ? ' Run myco runner doctor to check which coding agents can run.' : ''}`;

/** Where a member changes this machine's capture settings in the dashboard. */
export const MACHINE_SETTINGS_CONTROLS = { page: 'My machines', path: '/me/machines', action: 'Its settings' } as const;
export const machineSettingsLocation = (serverUrl: string | null): string =>
  `the dashboard${serverUrl === null ? '' : ` (${serverUrl}${MACHINE_SETTINGS_CONTROLS.path})`}, under ${MACHINE_SETTINGS_CONTROLS.page} › ${MACHINE_SETTINGS_CONTROLS.action} for this machine`;

/** The machine's global tools use this Deployment; capture keeps its own routing. */
export const harnessToolsElsewhere = (harness: string, machine: string, address?: string): string =>
  `${harness}'s Myco tools on ${machine} use ${address === undefined ? 'another Myco' : address.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
