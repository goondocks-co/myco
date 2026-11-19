import { credentialLive } from '../liveness.js';

/**
 * True while the machine named by `machineColumn` is in contact with this Deployment: it holds a credential that
 * authenticates (`credentialLive` at `now`), as an allowed machine does. A machine holding none is a former machine.
 * A machine keeps its credential live only by refreshing it with this Deployment, so its next report restores contact.
 */
export const machineInContactSql = (machineColumn: string, now: string): string =>
  `EXISTS (SELECT 1 FROM member_credentials contact INDEXED BY idx_member_credentials_machine
    WHERE contact.machine_id = ${machineColumn} AND ${credentialLive('contact', now)})`;
