import { SECRET_SLOTS } from '@goondocks/myco-shared/secret-slots';
import type { RecoveryCredential } from '@myco-server-worker/db/settings/recovery-credentials.js';

/** Names and re-entry locations for credentials omitted from a recovered Deployment. */
export function recoveryCredentialLines(credentials: readonly RecoveryCredential[]): string[] {
  return ['Stored credentials must be entered again:', ...(credentials.length === 0 ? ['  None were stored.'] : credentials.map(credential => {
    const label = SECRET_SLOTS.find(slot => slot.name === credential.name)?.label;
    return label === undefined ? '  Unused stored credential: no re-entry is needed.' : `  ${label}: Settings → Models and keys`;
  }))];
}
