import type { RelationalStore } from '../core/adapters.js';
import { boundWriteGuardStore } from '../core/write-guard-store.js';
import { CREDENTIAL_ENDED, credentialWriteAuthority, GRANT_ENDED, grantWriteAuthority } from '../db/auth/write-authority.js';
import { refused } from '../db/index.js';
import { TokenRevokedError } from '../telemetry.js';

/** What a tool call's write answers when the grant behind it ended between its authorization and its commit. */
export class GrantEndedError extends Error {
  constructor(readonly grantId: string) {
    super('grant ended');
    this.name = 'GrantEndedError';
  }
}

interface CredentialWriter { tokenId: string; memberId: string; clock: () => number }
interface GrantWriter { grantId: string; projectId: string; clock: () => number }

/** Every write through this store commits only while the credential and its member still hold. */
export function credentialWriteStore(db: RelationalStore, writer: CredentialWriter): RelationalStore {
  return boundWriteGuardStore(db, () => credentialWriteAuthority.bind(writer.tokenId, writer.memberId, writer.clock()), error => {
    if (refused(error, CREDENTIAL_ENDED)) throw new TokenRevokedError(writer.tokenId);
    throw error;
  });
}

/** Every write through this store commits only while the grant still holds for its Project. */
export function grantWriteStore(db: RelationalStore, writer: GrantWriter): RelationalStore {
  return boundWriteGuardStore(db, () => grantWriteAuthority.bind(writer.grantId, writer.projectId, writer.clock()), error => {
    if (refused(error, GRANT_ENDED)) throw new GrantEndedError(writer.grantId);
    throw error;
  });
}
