/**
 * myco_phase_audit — read the per-phase audit trail for an agent run.
 *
 * Mirrors GET /api/agent/runs/:id/audit. Returns a joined view over
 * agent_runs, agent_reports, agent_turns, usage_data, checkpoints, and
 * (for dry runs) agent_run_write_intents.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { extractErrorMessage } from './error.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhaseAuditInput {
  run_id: string;
}

export interface PhaseAuditHandlerResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoPhaseAudit(
  input: PhaseAuditInput,
  client: DaemonClient,
): Promise<PhaseAuditHandlerResult> {
  if (!input.run_id) {
    return { ok: false, error: 'run_id is required' };
  }

  const result = await client.get(
    `/api/agent/runs/${encodeURIComponent(input.run_id)}/audit`,
  );
  if (!result.ok) {
    return {
      ok: false,
      error: extractErrorMessage(result.data, 'not_found'),
    };
  }
  return { ok: true, data: result.data };
}
