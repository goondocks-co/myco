/**
 * myco_cortex — Cortex instruction + prompt-builder surface.
 *
 * Mirrors /api/cortex/* so agents can:
 *   - read their current session-start instructions
 *   - refresh them (kicks off the cortex-instructions task)
 *   - start a prompt-builder run for a goal
 *   - poll the prompt-builder result by run id
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CortexOp = 'get' | 'refresh' | 'build_prompt' | 'get_prompt_result';

export interface CortexInput {
  op: CortexOp;
  run_id?: string;
  goal?: string;
  symbiont?: string;
}

export interface CortexHandlerResult {
  ok: boolean;
  op: CortexOp;
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoCortex(
  input: CortexInput,
  client: DaemonClient,
): Promise<CortexHandlerResult> {
  switch (input.op) {
    case 'get': {
      const result = await client.get('/api/cortex/instructions');
      if (!result.ok) return { ok: false, op: input.op, error: 'fetch_failed' };
      return { ok: true, op: input.op, data: result.data };
    }

    case 'refresh': {
      const result = await client.post('/api/cortex/instructions/refresh', {});
      if (!result.ok) return { ok: false, op: input.op, error: 'refresh_failed' };
      return { ok: true, op: input.op, data: result.data };
    }

    case 'build_prompt': {
      if (!input.goal || input.goal.trim().length === 0) {
        return { ok: false, op: input.op, error: 'goal is required' };
      }
      const body: Record<string, unknown> = { goal: input.goal };
      if (input.symbiont) body.symbiont = input.symbiont;
      const result = await client.post('/api/cortex/prompt-builder', body);
      if (!result.ok) return { ok: false, op: input.op, error: 'build_prompt_failed' };
      return { ok: true, op: input.op, data: result.data };
    }

    case 'get_prompt_result': {
      if (!input.run_id) {
        return { ok: false, op: input.op, error: 'run_id is required' };
      }
      const result = await client.get(
        `/api/cortex/prompt-builder/${encodeURIComponent(input.run_id)}`,
      );
      if (!result.ok) {
        return { ok: false, op: input.op, error: 'not_ready_or_not_found' };
      }
      return { ok: true, op: input.op, data: result.data };
    }

    default: {
      // TypeScript exhaustiveness — should be unreachable.
      const _exhaustive: never = input.op;
      return { ok: false, op: _exhaustive, error: 'unknown_op' };
    }
  }
}
