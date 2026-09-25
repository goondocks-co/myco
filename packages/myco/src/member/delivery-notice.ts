/**
 * What the member tells the person when its capture can no longer reach the
 * Deployment on its own: the credential's rotation was refused for good, so
 * delivery stops at the token's expiry — or already has.
 *
 * Capture keeps spooling either way; the notice says so and names the one act
 * that resumes delivery. Every hook that dials prints it to stderr, and the
 * session-start hook of a symbiont that takes an injection hands it to the
 * agent, which is where a person working in the session reads it.
 */
import type { HookResponse } from '../hooks/response.js';
import type { CredentialRecord } from './credential.js';

/** The act that replaces a credential the Deployment no longer rotates. */
export const REJOIN_HINT = 'ask a Deployment admin for an invite link and run `myco login <link>`';

/** The notice for a credential, or null while it is still rotating. */
export function deliveryNotice(credential: Pick<CredentialRecord, 'serverUrl' | 'expiresAt' | 'refreshTerminal'>, now: number): string | null {
  if (credential.refreshTerminal !== true) return null;
  if (credential.expiresAt !== undefined && credential.expiresAt > now) {
    return `Myco can no longer renew this machine's membership of ${credential.serverUrl}; capture stops reaching it at ${new Date(credential.expiresAt).toISOString()}. To keep it delivered, ${REJOIN_HINT}.`;
  }
  return `Myco capture is not being delivered: this machine's membership of ${credential.serverUrl} has ended. What is captured stays on this machine and is delivered once you ${REJOIN_HINT}.`;
}

/** A hook answer with the notice after whatever it already carries, in each of the forms the answer may take. */
export function withNotice(text: string, response: HookResponse): HookResponse {
  return {
    ...response,
    additionalContext: [response.additionalContext, text].filter((part): part is string => part !== undefined && part.length > 0).join('\n\n'),
    ...(response.additionalSteps ? { additionalSteps: [...response.additionalSteps, text] } : {}),
  };
}
