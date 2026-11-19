import { MEMBER_TOKEN_TTL_MS } from '../../constants.js';
import { credentialLive } from '../liveness.js';

/**
 * True while the machine named by `machineColumn` is in contact with this Deployment: it holds a credential that
 * authenticates (`credentialLive` at `now`), as an allowed machine does. A machine holding none is a former machine.
 * A machine keeps its credential live only by refreshing it with this Deployment, so its next report restores contact.
 *
 * Every credential is minted with `expires_at = issued_at + MEMBER_TOKEN_TTL_MS` and its expiry is never moved, so a
 * credential unexpired at `now` was issued after `now - MEMBER_TOKEN_TTL_MS`. The read seeks the machine's credentials
 * from that instant on in `idx_member_credentials_machine`: what it reads follows the credentials issued within one
 * lifetime, never the expired ones a machine accumulates.
 */
export const machineInContactSql = (machineColumn: string, now: string): string =>
  `EXISTS (SELECT 1 FROM member_credentials contact INDEXED BY idx_member_credentials_machine
    WHERE contact.machine_id = ${machineColumn} AND contact.issued_at > ${now} - ${MEMBER_TOKEN_TTL_MS} AND ${credentialLive('contact', now)})`;
