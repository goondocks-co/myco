/** Recovery words shared by the terminal and dashboard. */
export const OWNER_SETUP_COMMAND = 'myco server setup-owner';
export const SIGN_IN_SETUP_COMMAND = 'myco server github-app';
export const OWNER_UNCLAIMED = `This Myco has no owner yet, so nobody can approve this machine. Whoever created it must run ${OWNER_SETUP_COMMAND} on the machine that created it, then open and complete the fresh owner link.`;
export const OWNER_LINK_DENIED = `This owner link has expired or was already used. On the machine that created this Myco, run ${OWNER_SETUP_COMMAND} again for a fresh link, then open and complete it.`;
export const SIGN_IN_UNCONFIGURED = `GitHub sign-in is not set up for this Myco. Whoever created it must run ${SIGN_IN_SETUP_COMMAND} on the machine that created it, then reload this page.`;
export const ACCOUNT_UNLINKED = 'Your GitHub account is not connected to a member of this Myco. Ask an owner or admin to connect it from People & machines, then open the link they send while signed in to this account.';
export const SIGN_IN_WAIT = 'If nobody approves within 10 minutes, this stops; the approval page says what is missing.';
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
export const noOwnerSignIn = (url: string): string => `${url} has no owner yet, so nobody can approve this machine. Whoever created it finishes with ${OWNER_SETUP_COMMAND} on the machine that created it, then run myco login ${url} again.`;
