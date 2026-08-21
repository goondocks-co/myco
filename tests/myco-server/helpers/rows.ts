import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';

/** The row shape returned by the authenticator's read: the schema version joined to a member row, or to nulls when no digest matched. */
export function authRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: String(SERVER_SCHEMA_VERSION),
    id: 'mt_1', project_id: 'proj_1', machine_id: 'machine_1',
    expires_at: 2_000, revoked_at: null, bytes_written: 0,
    lineage_root: 'mt_1', lineage_started_at: 1_000, predecessor_id: null, first_used_at: null,
    ...over,
  };
}

/** The authenticator's read when the digest matches no member row. */
export function noMemberRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return authRow({ id: null, project_id: null, machine_id: null, expires_at: null, revoked_at: null, bytes_written: null, lineage_root: null, lineage_started_at: null, predecessor_id: null, first_used_at: null, ...over });
}
