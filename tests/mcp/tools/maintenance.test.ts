/**
 * myco_maintenance — operator action parity coverage (Stream J / J1).
 *
 * The handler is a thin proxy onto existing scoped HTTP routes. The
 * tests assert: (a) op routing — each op hits the right endpoint, (b)
 * scope envelope — bodies forward `scope` verbatim including
 * `all-groves`, (c) request-context headers — daemon receives the
 * resolved (Grove, project) so its server-side parser keeps the same
 * scope semantics it uses for UI calls, (d) typed errors — daemon
 * `{ error, message }` envelopes round-trip as `ToolFailure` objects
 * instead of opaque dispatcher failures.
 */

import { describe, it, expect } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleMycoMaintenance, MAINTENANCE_OPS } from '@myco/tools/maintenance.js';
import { resolveLegacyRequestContext } from '@myco/tools/request-context.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import type { DaemonClient } from '@myco/hooks/client.js';

const PROJECT_ID = assertGroveProjectId(createProjectId());
const REQUEST_CONTEXT = resolveLegacyRequestContext('/tmp/myco-maint-test', {
  projectId: PROJECT_ID,
  groveId: 'grove-test',
  machineId: 'machine-test',
});

interface CapturedCall {
  method: 'GET' | 'POST';
  endpoint: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function captureClient(response?: { ok?: boolean; data?: unknown }): { client: DaemonClient; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const result = { ok: response?.ok ?? true, data: response?.data ?? { ok: true } };
  const client = {
    get: vi.fn(async (endpoint: string, options?: { headers?: Record<string, string> }) => {
      calls.push({ method: 'GET', endpoint, headers: options?.headers });
      return result;
    }),
    post: vi.fn(async (endpoint: string, body: unknown, options?: { headers?: Record<string, string> }) => {
      calls.push({ method: 'POST', endpoint, body, headers: options?.headers });
      return result;
    }),
    put: vi.fn(async () => result),
    delete: vi.fn(async () => result),
  } as unknown as DaemonClient;
  return { client, calls };
}

describe('myco_maintenance handler', () => {
  it('exports the canonical op enum used by the schema', () => {
    expect(MAINTENANCE_OPS).toEqual([
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
      // Daemon lifecycle intent ops (F.1-F.3).
      'intent_status',
      'restart',
      'update_pin',
      'cancel_update',
    ]);
  });

  it('rejects calls without an op', async () => {
    const { client } = captureClient();
    await expect(handleMycoMaintenance({}, client, REQUEST_CONTEXT)).rejects.toThrow(/op is required/);
  });

  it('rejects unknown ops with a typed error', async () => {
    const { client } = captureClient();
    await expect(handleMycoMaintenance({ op: 'database_explode' as never }, client, REQUEST_CONTEXT))
      .rejects.toThrow(/Unknown op/);
  });

  it.each([
    ['database_optimize', '/api/database/optimize'],
    ['database_vacuum', '/api/database/vacuum'],
    ['database_reindex', '/api/database/reindex'],
    ['database_integrity_check', '/api/database/integrity-check'],
    ['embedding_reconcile', '/api/embedding/reconcile'],
    ['backup_now', '/api/backup'],
  ] as const)('routes op: "%s" to POST %s', async (op, expectedEndpoint) => {
    const { client, calls } = captureClient();
    await handleMycoMaintenance({ op, scope: { kind: 'all-groves' } }, client, REQUEST_CONTEXT);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].endpoint).toBe(expectedEndpoint);
    expect(calls[0].body).toEqual({ scope: { kind: 'all-groves' } });
    // Request-context headers always forwarded so daemon-side scope
    // resolution matches UI-side resolution.
    expect(calls[0].headers).toMatchObject({
      'x-myco-project-id': PROJECT_ID,
      'x-myco-grove-id': 'grove-test',
    });
  });

  it('routes op: "embedding_rebuild" with async query param when async: true', async () => {
    const { client, calls } = captureClient();
    await handleMycoMaintenance({ op: 'embedding_rebuild', async: true, scope: { kind: 'grove', grove_id: 'g1' } }, client, REQUEST_CONTEXT);
    expect(calls[0].endpoint).toBe('/api/embedding/rebuild?async=true');
    expect(calls[0].body).toEqual({ scope: { kind: 'grove', grove_id: 'g1' } });
  });

  it('routes op: "embedding_rebuild" without async query param by default', async () => {
    const { client, calls } = captureClient();
    await handleMycoMaintenance({ op: 'embedding_rebuild' }, client, REQUEST_CONTEXT);
    expect(calls[0].endpoint).toBe('/api/embedding/rebuild');
    expect(calls[0].body).toEqual({});
  });

  it('routes op: "backup_list" to GET /api/backups', async () => {
    const { client, calls } = captureClient({ data: { backups: [] } });
    const result = await handleMycoMaintenance({ op: 'backup_list' }, client, REQUEST_CONTEXT);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].endpoint).toBe('/api/backups');
    expect(result).toEqual({ backups: [] });
  });

  it.each([
    ['restore_preview', '/api/restore/preview'],
    ['restore', '/api/restore'],
  ] as const)('routes op: "%s" with file_name in body', async (op, expectedEndpoint) => {
    const { client, calls } = captureClient();
    await handleMycoMaintenance(
      { op, file_name: 'backup-2026-05-08.sqlite', scope: { kind: 'grove', grove_id: 'g1' } },
      client,
      REQUEST_CONTEXT,
    );
    expect(calls[0].method).toBe('POST');
    expect(calls[0].endpoint).toBe(expectedEndpoint);
    expect(calls[0].body).toEqual({
      file_name: 'backup-2026-05-08.sqlite',
      scope: { kind: 'grove', grove_id: 'g1' },
    });
  });

  it('routes op: "restore_preview" with machine_id when no file_name', async () => {
    const { client, calls } = captureClient();
    await handleMycoMaintenance({ op: 'restore_preview', machine_id: 'machine-x' }, client, REQUEST_CONTEXT);
    expect(calls[0].body).toEqual({ machine_id: 'machine-x' });
  });

  it('rejects restore ops missing both file_name and machine_id', async () => {
    const { client } = captureClient();
    await expect(handleMycoMaintenance({ op: 'restore' }, client, REQUEST_CONTEXT))
      .rejects.toThrow(/file_name or machine_id/);
  });

  it('validates scope.kind: "project" requires both grove_id and project_id', async () => {
    const { client } = captureClient();
    await expect(handleMycoMaintenance(
      { op: 'database_optimize', scope: { kind: 'project', grove_id: 'g1' } as never },
      client,
      REQUEST_CONTEXT,
    )).rejects.toThrow(/scope.project_id is required/);
  });

  it('validates scope.kind: "grove" requires grove_id', async () => {
    const { client } = captureClient();
    await expect(handleMycoMaintenance(
      { op: 'database_optimize', scope: { kind: 'grove' } as never },
      client,
      REQUEST_CONTEXT,
    )).rejects.toThrow(/scope.grove_id is required/);
  });

  it('rejects unknown scope.kind', async () => {
    const { client } = captureClient();
    await expect(handleMycoMaintenance(
      { op: 'database_optimize', scope: { kind: 'global' } as never },
      client,
      REQUEST_CONTEXT,
    )).rejects.toThrow(/scope.kind must be one of/);
  });

  it('omits scope from body when not provided (legacy single-Grove path)', async () => {
    const { client, calls } = captureClient();
    await handleMycoMaintenance({ op: 'database_optimize' }, client, REQUEST_CONTEXT);
    expect(calls[0].body).toEqual({});
  });

  it('surfaces typed daemon errors as ToolFailure objects', async () => {
    const { client } = captureClient({ ok: false, data: { error: 'vacuum_precheck_failed', message: 'Need more disk' } });
    const result = await handleMycoMaintenance({ op: 'database_vacuum' }, client, REQUEST_CONTEXT);
    expect(result).toEqual({ ok: false, error: 'vacuum_precheck_failed: Need more disk' });
  });

  it('falls back to a generic error when daemon returns no envelope', async () => {
    const { client } = captureClient({ ok: false, data: undefined });
    const result = await handleMycoMaintenance({ op: 'database_optimize' }, client, REQUEST_CONTEXT);
    expect(result).toEqual({ ok: false, error: 'Maintenance call to /api/database/optimize failed' });
  });
});
