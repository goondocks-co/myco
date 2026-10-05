import { defaultMembership, readDefaultDeployment } from './default-deployment.js';
import {
  deploymentUrl, listDeploymentMembershipsResult, readDeploymentMembershipResult, type DeploymentMembership,
} from './registry.js';

export type MemberTokenSource = 'registry' | 'env';

export interface TokenPairableClient {
  serverUrl: string;
  credentialSource: MemberTokenSource;
  tokenMatches(token: string): boolean;
}

function assertPair(serverUrl: string, mycoHome: string, source: MemberTokenSource, matchesToken: (token: string) => boolean): void {
  const destination = deploymentUrl(serverUrl);
  const exact = readDeploymentMembershipResult(destination, mycoHome);
  if (exact.status === 'unavailable') throw new Error('Member destination membership is unavailable');
  const listed = listDeploymentMembershipsResult(mycoHome);
  if (!listed.readable || listed.unavailableEntries > 0) throw new Error('Member memberships are unavailable');
  if (listed.memberships.some((membership) => deploymentUrl(membership.serverUrl) !== destination && matchesToken(membership.token))) {
    throw new Error('Member credential belongs to another Deployment');
  }
  if (source === 'registry') {
    if (exact.status !== 'present' || !matchesToken(exact.membership.token)) {
      throw new Error('Member credential does not belong to its destination membership');
    }
  }
}

/** Verify the token used for a destination against this home's membership records before delivery. */
export function assertDeploymentTokenPair(
  record: { serverUrl: string; token: string }, mycoHome: string, source: MemberTokenSource = 'registry',
): void {
  assertPair(record.serverUrl, mycoHome, source, (token) => token === record.token);
}

/** Verify a client's token without exposing it to the spool or a diagnostic. */
export function assertClientTokenPair(client: TokenPairableClient, mycoHome: string): void {
  assertPair(client.serverUrl, mycoHome, client.credentialSource, (token) => client.tokenMatches(token));
}

/** Choose an explicitly named Deployment or the recorded default. */
export function selectedDeploymentMembership(mycoHome: string, serverUrl?: string): DeploymentMembership | null {
  if (serverUrl !== undefined) {
    const exact = readDeploymentMembershipResult(serverUrl, mycoHome);
    return exact.status === 'present' ? exact.membership : null;
  }
  if (readDefaultDeployment(mycoHome) !== null) return defaultMembership(mycoHome);
  return null;
}
