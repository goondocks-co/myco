import { noOwnerSignIn, SIGN_IN_WAIT } from '@goondocks/myco-shared/setup-guidance';
import type { ExchangeResult, JoinAnswer } from '../member/join-code.js';
import { runDeviceFlow, type DeviceFlowDeps, type DeviceFlowSpec } from './device-flow.js';

const memberSignIn = (serverUrl: string): DeviceFlowSpec<JoinAnswer> => ({
  noun: 'sign-in',
  startPath: '/auth/device/start',
  pollPath: '/auth/device/poll',
  announce: (userCode) => [
    `Open ${serverUrl}/device on a machine signed in to the dashboard.`,
    `Code: ${userCode}`,
    'Check the machine details and approve it there. Waiting for approval…',
    SIGN_IN_WAIT,
  ],
  accept: (response, answer) => response.ok && answer.joined === true && typeof answer.memberId === 'string' && typeof answer.token === 'string'
    && typeof answer.tokenId === 'string' && typeof answer.expiresAt === 'number' && Number.isFinite(answer.expiresAt)
    && (answer.memberLabel === undefined || answer.memberLabel === null || typeof answer.memberLabel === 'string')
    && (answer.owner === undefined || typeof answer.owner === 'boolean')
    && (answer.role === 'member' || answer.role === 'admin') && (answer.projectId === null || typeof answer.projectId === 'string')
    ? answer as unknown as JoinAnswer : null,
  startRefusals: { no_owner: noOwnerSignIn(serverUrl) },
  refusals: {
    access_denied: 'sign-in was denied in the dashboard; run myco login again and approve only your own machine',
    expired_token: 'sign-in expired; run myco login again',
    invalid_grant: 'sign-in has expired or was already used; run myco login again',
    identity_claimed: 'this machine belongs to another member; sign in with that member’s GitHub account, then run myco login again',
  },
  otherRefusal: 'the Deployment refused this sign-in; run myco login again',
});

/** Device secrets travel only in POST bodies. Only the human code and the verification address are printed. */
export function deviceLogin(serverUrl: string, machine: { machineId: string; machineName: string; os: string }, deps: DeviceFlowDeps): Promise<ExchangeResult> {
  return runDeviceFlow(serverUrl, memberSignIn(serverUrl), machine, deps);
}
