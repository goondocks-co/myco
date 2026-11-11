/**
 * What a recovered store sheds before it serves: pending device decisions and the runner reports the copy carried and,
 * for a fork, the Deployment identity, every live authority and every run still in flight.
 */
import { IN_FLIGHT_RUN_STATUSES } from '../run-statuses.js';
import { write, type Bound } from '../index.js';

const expireDeviceRequests = write<[now: number]>({ name: 'recovery.expireCarriedDeviceRequests', sql:
  'UPDATE device_requests SET expires_at = ?1 WHERE decision IS NULL AND expires_at > ?1' });
const RUNNER_REPORTS = ['runner_contacts', 'runner_observations', 'runner_model_catalogs', 'runner_update_requests', 'runner_update_reports'] as const;
const dropRunnerReports = RUNNER_REPORTS.map(table => write<[]>({ name: `recovery.dropCarried${table.split('_').map(word => `${word[0]!.toUpperCase()}${word.slice(1)}`).join('')}`,
  sql: `DELETE FROM ${table}` }));

/** A pending sign-in or runner registration no longer admits a decision, and runners report again. */
export function carriedStateStatements(now: number): Bound<never, 'write'>[] {
  return [expireDeviceRequests.bind(now), ...dropRunnerReports.map(statement => statement.bind())];
}

const rotateIdentity = write<[identity: string, original: string]>({ name: 'recovery.rotateDeploymentIdentity', sql:
  "UPDATE schema_meta SET value = ?1 WHERE key = 'deployment_id' AND value = ?2" });
const AUTHORITY_TABLES = ['member_credentials', 'runner_credentials', 'enrollment_authorities', 'identity_link_authorities', 'external_grants'] as const;
const revokeAuthorities = AUTHORITY_TABLES.map(table => write<[now: number]>({
  name: `recovery.revokeCopied${table.split('_').map(word => `${word[0]!.toUpperCase()}${word.slice(1)}`).join('')}`,
  sql: `UPDATE ${table} SET revoked_at = ?1 WHERE revoked_at IS NULL` }));
const failCopiedRuns = write<[now: number]>({ name: 'recovery.failCopiedRuns', sql:
  `UPDATE agent_runs SET status = 'failed', completed_at = ?1, error = 'Deployment fork ended the copied run',
      lease_expires_at = NULL, resumable = 0 WHERE ${IN_FLIGHT_RUN_STATUSES}` });

/** A fork takes a new identity, sheds the carried state, retires every copied live authority and ends every copied run. */
export function forkTenantStatements(identity: string, original: string, now: number): Bound<never, 'write'>[] {
  return [rotateIdentity.bind(identity, original), ...carriedStateStatements(now),
    ...revokeAuthorities.map(statement => statement.bind(now)), failCopiedRuns.bind(now)];
}
