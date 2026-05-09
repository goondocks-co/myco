/**
 * myco_update — agent-driven self-update parity coverage (Stream J / J2).
 *
 * The handler is a thin proxy onto the daemon's /api/update/* routes.
 * Tests verify (a) op routing — each op hits the correct
 * method+endpoint, (b) channel parameter is required for set_channel,
 * (c) request-context headers always flow through so the daemon sees
 * the same scope identity it sees for UI calls, (d) typed daemon
 * errors round-trip as `ToolFailure`.
 *
 * Cross-Grove fan-out is NOT a tool-level concern: `/api/update/apply`
 * spawns the binary install script which calls `myco update
 * --all-projects` post-install (commit 645983af). One op: "apply"
 * therefore drives every registered project — no separate parameter
 * required.
 */

import { describe, it, expect } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleMycoUpdate, UPDATE_OPS } from '@myco/tools/update.js';
import { resolveLegacyRequestContext } from '@myco/tools/request-context.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import type { DaemonClient } from '@myco/hooks/client.js';

const PROJECT_ID = assertGroveProjectId(createProjectId());
const REQUEST_CONTEXT = resolveLegacyRequestContext('/tmp/myco-update-test', {
  projectId: PROJECT_ID,
  groveId: 'grove-test',
  machineId: 'machine-test',
});

interface CapturedCall {
  method: 'GET' | 'POST' | 'PUT';
  endpoint: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function captureClient(response?: { ok?: boolean; data?: unknown }): { client: DaemonClient; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const result = { ok: response?.ok ?? true, data: response?.data ?? {} };
  const client = {
    get: vi.fn(async (endpoint: string, options?: { headers?: Record<string, string> }) => {
      calls.push({ method: 'GET', endpoint, headers: options?.headers });
      return result;
    }),
    post: vi.fn(async (endpoint: string, body: unknown, options?: { headers?: Record<string, string> }) => {
      calls.push({ method: 'POST', endpoint, body, headers: options?.headers });
      return result;
    }),
    put: vi.fn(async (endpoint: string, body: unknown, options?: { headers?: Record<string, string> }) => {
      calls.push({ method: 'PUT', endpoint, body, headers: options?.headers });
      return result;
    }),
    delete: vi.fn(async () => result),
  } as unknown as DaemonClient;
  return { client, calls };
}

describe('myco_update handler', () => {
  it('exports the canonical op enum used by the schema', () => {
    expect(UPDATE_OPS).toEqual(['status', 'check', 'apply', 'set_channel']);
  });

  it('defaults to op: "status" when none is supplied', async () => {
    const { client, calls } = captureClient({ data: { running_version: '1.0.0' } });
    const result = await handleMycoUpdate({}, client, REQUEST_CONTEXT) as { running_version: string };
    expect(calls[0].method).toBe('GET');
    expect(calls[0].endpoint).toBe('/api/update/status');
    expect(result.running_version).toBe('1.0.0');
  });

  it('routes op: "status" to GET /api/update/status with context headers', async () => {
    const { client, calls } = captureClient({ data: { exempt: false, update_available: false } });
    await handleMycoUpdate({ op: 'status' }, client, REQUEST_CONTEXT);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].endpoint).toBe('/api/update/status');
    expect(calls[0].headers).toMatchObject({
      'x-myco-project-id': PROJECT_ID,
      'x-myco-grove-id': 'grove-test',
    });
  });

  it('routes op: "check" to POST /api/update/check', async () => {
    const { client, calls } = captureClient();
    await handleMycoUpdate({ op: 'check' }, client, REQUEST_CONTEXT);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].endpoint).toBe('/api/update/check');
  });

  it('routes op: "apply" to POST /api/update/apply', async () => {
    const { client, calls } = captureClient({ data: { status: 'applying', version: '1.1.0' } });
    const result = await handleMycoUpdate({ op: 'apply' }, client, REQUEST_CONTEXT) as { status: string; version: string };
    expect(calls[0].method).toBe('POST');
    expect(calls[0].endpoint).toBe('/api/update/apply');
    expect(result.status).toBe('applying');
    expect(result.version).toBe('1.1.0');
  });

  it('routes op: "set_channel" to PUT /api/update/channel with the channel body', async () => {
    const { client, calls } = captureClient();
    await handleMycoUpdate({ op: 'set_channel', channel: 'beta' }, client, REQUEST_CONTEXT);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].endpoint).toBe('/api/update/channel');
    expect(calls[0].body).toEqual({ channel: 'beta' });
  });

  it('rejects op: "set_channel" without a channel value', async () => {
    const { client } = captureClient();
    await expect(handleMycoUpdate({ op: 'set_channel' }, client, REQUEST_CONTEXT))
      .rejects.toThrow(/channel is required/);
  });

  it('rejects unknown ops with a typed error', async () => {
    const { client } = captureClient();
    await expect(handleMycoUpdate({ op: 'rollback' as never }, client, REQUEST_CONTEXT))
      .rejects.toThrow(/Unknown op/);
  });

  it('surfaces typed daemon errors as ToolFailure', async () => {
    const { client } = captureClient({ ok: false, data: { error: 'no_update_available' } });
    const result = await handleMycoUpdate({ op: 'apply' }, client, REQUEST_CONTEXT);
    expect(result).toEqual({ ok: false, error: 'no_update_available' });
  });

  it('falls back to a generic error when the daemon returns no envelope', async () => {
    const { client } = captureClient({ ok: false, data: undefined });
    const result = await handleMycoUpdate({ op: 'check' }, client, REQUEST_CONTEXT);
    expect(result).toEqual({ ok: false, error: 'update check failed' });
  });

  it('works without a request context (legacy single-project flow)', async () => {
    const { client, calls } = captureClient();
    await handleMycoUpdate({ op: 'status' }, client);
    expect(calls[0].headers).toBeUndefined();
  });
});
