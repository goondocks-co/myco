/**
 * myco_update — agent-driven self-update for the Myco binary.
 *
 * Stream J — agent-native parity. The CLI's `myco update`
 * (and especially `myco update --all-projects` per commit 645983af)
 * already drives cross-Grove update fan-out, but the only programmatic
 * surface for it was HTTP. This tool wraps the existing daemon update
 * routes so an agent can drive the lifecycle without shelling out.
 *
 * Apply note: `/api/update/apply` spawns the binary install script,
 * which in turn invokes `myco update --all-projects` post-install
 * (see `daemon/update-installer.ts`). One op: "apply" call therefore
 * drives every registered project — no separate `all_projects`
 * parameter is required at the HTTP boundary.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { ToolError, type ToolFailure } from './error.js';
import { requestContextHeaders, type MycoRequestContext } from './request-context.js';

export const UPDATE_OPS = ['status', 'check', 'apply', 'set_channel'] as const;
export type UpdateOp = typeof UPDATE_OPS[number];

export interface UpdateInput {
  op?: UpdateOp;
  channel?: 'stable' | 'beta';
}

export async function handleMycoUpdate(
  input: UpdateInput,
  client: DaemonClient,
  requestContext?: MycoRequestContext,
): Promise<unknown | ToolFailure> {
  const op = input.op ?? 'status';
  if (!UPDATE_OPS.includes(op)) {
    throw new ToolError('invalid_input', `Unknown op '${op}' for myco_update`);
  }

  const headers = requestContext ? requestContextHeaders(requestContext) : undefined;

  switch (op) {
    case 'status': {
      const result = headers
        ? await client.get('/api/update/status', { headers })
        : await client.get('/api/update/status');
      if (!result.ok) return failure(result, 'update status');
      return result.data;
    }
    case 'check': {
      const result = headers
        ? await client.post('/api/update/check', {}, { headers })
        : await client.post('/api/update/check', {});
      if (!result.ok) return failure(result, 'update check');
      return result.data;
    }
    case 'apply': {
      const result = headers
        ? await client.post('/api/update/apply', {}, { headers })
        : await client.post('/api/update/apply', {});
      if (!result.ok) return failure(result, 'update apply');
      return result.data;
    }
    case 'set_channel': {
      if (!input.channel) {
        throw new ToolError('invalid_input', `channel is required for op: set_channel (one of: stable, beta)`);
      }
      const result = headers
        ? await client.put('/api/update/channel', { channel: input.channel }, { headers })
        : await client.put('/api/update/channel', { channel: input.channel });
      if (!result.ok) return failure(result, 'update channel');
      return result.data;
    }
  }
}

function failure(result: { data?: unknown }, label: string): ToolFailure {
  const data = result.data as { error?: string; message?: string } | undefined;
  if (data && typeof data.error === 'string') {
    return { ok: false, error: data.message ? `${data.error}: ${data.message}` : data.error };
  }
  return { ok: false, error: `${label} failed` };
}
