/**
 * myco_resume_run — resume a paused or interrupted agent run.
 *
 * Mirrors POST /api/agent/runs/:id/resume. The run must be in a resumable
 * state (`resumable=1` AND `status='failed'` per the route); check status
 * via myco_runs first.
 *
 * NOT read-only. NOT idempotent — each call starts a new background phase
 * if the run is still resumable.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { extractErrorMessage } from './error.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResumeRunMode = 'manual' | 'scheduled';

export interface ResumeRunInput {
  id: string;
  mode?: ResumeRunMode;
}

export interface ResumeRunHandlerResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoResumeRun(
  input: ResumeRunInput,
  client: DaemonClient,
): Promise<ResumeRunHandlerResult> {
  if (!input.id) {
    return { ok: false, error: 'id is required' };
  }

  const body: Record<string, unknown> = {};
  if (input.mode) body.mode = input.mode;

  const result = await client.post(
    `/api/agent/runs/${encodeURIComponent(input.id)}/resume`,
    body,
  );
  if (!result.ok) {
    return {
      ok: false,
      error: extractErrorMessage(result.data, 'resume_failed'),
    };
  }
  return { ok: true, data: result.data };
}
