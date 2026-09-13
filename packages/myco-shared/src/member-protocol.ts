/** The protocol and project header names used by every member request. */
export const MEMBER_PROTOCOL = 1;
export const PROTOCOL_HEADER = 'x-myco-protocol';
export const PROJECT_HEADER = 'x-myco-project';

function credentialHeaders(token: string, protocol: number): Record<string, string> {
  return { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(protocol) };
}

/** A project-scoped request always declares both its protocol and project. */
export function memberHeaders(credential: { token: string; projectId: string }, protocol: number = MEMBER_PROTOCOL): Record<string, string> {
  return { ...credentialHeaders(credential.token, protocol), [PROJECT_HEADER]: credential.projectId };
}

/** Deployment-scoped requests carry no project header. */
export function deploymentScopedHeaders(credential: { token: string }, protocol: number = MEMBER_PROTOCOL): Record<string, string> {
  return credentialHeaders(credential.token, protocol);
}
