/**
 * myco_maintenance — operator action parity for the local MCP surface.
 *
 * Stream J's review flagged that the daemon UI exposes operator
 * workflows (database optimize/vacuum/reindex/integrity-check, embedding
 * reconcile/rebuild, backup-now, restore-preview, restore) reachable
 * only via HTTP — zero MCP tools cover them. This handler closes that
 * gap by dispatching ops to the existing scope-aware routes under
 * /api/database/*, /api/embedding/*, /api/backup, /api/backups, and
 * /api/restore*. The body envelope mirrors the UI's ActionScope so a
 * `kind: "all-groves"` agent action fans out the same way the
 * "Reconcile All Groves" button does.
 *
 * Keep this handler thin: every op is a one-shot proxy to an existing
 * daemon endpoint. The daemon owns scope resolution, in-flight
 * coalescing, and per-Grove fan-out; the tool's only job is to
 * translate input into a body+endpoint pair and forward request
 * context as headers.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { ToolError, type ToolFailure } from './error.js';
import { requestContextHeaders, type MycoRequestContext } from './request-context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const MAINTENANCE_OPS = [
  'database_optimize',
  'database_vacuum',
  'database_reindex',
  'database_integrity_check',
  'embedding_rebuild',
  'embedding_reconcile',
  'backup_now',
  'backup_list',
  'restore_preview',
  'restore',
] as const;

export type MaintenanceOp = typeof MAINTENANCE_OPS[number];

/**
 * Wire-compatible mirror of `ActionScope` from
 * `daemon/api/action-scope.ts`. We don't import that module from the
 * tool layer — the daemon owns its parser and we want zero dep churn
 * if the wire format evolves. The schema is duplicated by intent: the
 * daemon validates the body either way, and a typed local check rejects
 * obviously bad input before the HTTP round-trip.
 */
export type MaintenanceScope =
  | { kind: 'project'; grove_id: string; project_id: string }
  | { kind: 'grove'; grove_id: string }
  | { kind: 'all-groves' };

export interface MaintenanceInput {
  op?: MaintenanceOp;
  scope?: MaintenanceScope;
  /** restore_preview / restore — point-in-time backup file name. */
  file_name?: string;
  /** restore_preview / restore — machine id (newest backup for that machine). */
  machine_id?: string;
  /** embedding_rebuild — when true, queue work for the background loop and return immediately. */
  async?: boolean;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoMaintenance(
  input: MaintenanceInput,
  client: DaemonClient,
  requestContext?: MycoRequestContext,
): Promise<unknown | ToolFailure> {
  const op = input.op;
  if (!op) {
    throw new ToolError('invalid_input', `op is required for myco_maintenance (one of: ${MAINTENANCE_OPS.join(', ')})`);
  }
  if (!MAINTENANCE_OPS.includes(op)) {
    throw new ToolError('invalid_input', `Unknown op '${op}' for myco_maintenance`);
  }

  validateScope(input.scope);

  const headers = requestContext ? requestContextHeaders(requestContext) : undefined;
  const body = scopeBody(input.scope);

  switch (op) {
    case 'database_optimize':
      return await postScoped(client, '/api/database/optimize', body, headers);
    case 'database_vacuum':
      return await postScoped(client, '/api/database/vacuum', body, headers);
    case 'database_reindex':
      return await postScoped(client, '/api/database/reindex', body, headers);
    case 'database_integrity_check':
      return await postScoped(client, '/api/database/integrity-check', body, headers);
    case 'embedding_rebuild': {
      // Pass async via query string per the daemon's existing contract.
      const endpoint = input.async ? '/api/embedding/rebuild?async=true' : '/api/embedding/rebuild';
      return await postScoped(client, endpoint, body, headers);
    }
    case 'embedding_reconcile':
      return await postScoped(client, '/api/embedding/reconcile', body, headers);
    case 'backup_now':
      return await postScoped(client, '/api/backup', body, headers);
    case 'backup_list': {
      const result = headers
        ? await client.get('/api/backups', { headers })
        : await client.get('/api/backups');
      if (!result.ok || !result.data) {
        return { ok: false, error: 'Backup list unavailable' };
      }
      return result.data;
    }
    case 'restore_preview':
      return await postRestore(client, '/api/restore/preview', input, headers);
    case 'restore':
      return await postRestore(client, '/api/restore', input, headers);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateScope(scope: MaintenanceScope | undefined): void {
  if (scope === undefined) return;
  if (!scope || typeof scope !== 'object') {
    throw new ToolError('invalid_input', 'scope must be an object with kind: project|grove|all-groves');
  }
  switch (scope.kind) {
    case 'project':
      if (!scope.grove_id || typeof scope.grove_id !== 'string') {
        throw new ToolError('invalid_input', 'scope.grove_id is required for kind: project');
      }
      if (!scope.project_id || typeof scope.project_id !== 'string') {
        throw new ToolError('invalid_input', 'scope.project_id is required for kind: project');
      }
      return;
    case 'grove':
      if (!scope.grove_id || typeof scope.grove_id !== 'string') {
        throw new ToolError('invalid_input', 'scope.grove_id is required for kind: grove');
      }
      return;
    case 'all-groves':
      return;
    default:
      throw new ToolError('invalid_input', `scope.kind must be one of: project, grove, all-groves`);
  }
}

function scopeBody(scope: MaintenanceScope | undefined): Record<string, unknown> {
  return scope ? { scope } : {};
}

async function postScoped(
  client: DaemonClient,
  endpoint: string,
  body: Record<string, unknown>,
  headers: Record<string, string> | undefined,
): Promise<unknown | ToolFailure> {
  const result = headers
    ? await client.post(endpoint, body, { headers })
    : await client.post(endpoint, body);
  if (!result.ok) {
    return failureFromResult(result, endpoint);
  }
  return result.data;
}

async function postRestore(
  client: DaemonClient,
  endpoint: string,
  input: MaintenanceInput,
  headers: Record<string, string> | undefined,
): Promise<unknown | ToolFailure> {
  if (!input.file_name && !input.machine_id) {
    throw new ToolError('invalid_input', `restore ops require either file_name or machine_id`);
  }
  const body: Record<string, unknown> = {};
  if (input.file_name) body.file_name = input.file_name;
  if (input.machine_id) body.machine_id = input.machine_id;
  if (input.scope) body.scope = input.scope;
  const result = headers
    ? await client.post(endpoint, body, { headers })
    : await client.post(endpoint, body);
  if (!result.ok) return failureFromResult(result, endpoint);
  return result.data;
}

function failureFromResult(result: { data?: unknown }, endpoint: string): ToolFailure {
  // Surface the daemon's structured error envelope when present so the
  // agent sees vacuum_precheck_failed, no_update_available, etc., as
  // typed errors instead of an opaque "tool_call_failed".
  const data = result.data as { error?: string; message?: string } | undefined;
  if (data && typeof data.error === 'string') {
    return { ok: false, error: data.message ? `${data.error}: ${data.message}` : data.error };
  }
  return { ok: false, error: `Maintenance call to ${endpoint} failed` };
}
