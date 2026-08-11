/**
 * Agent run dispatcher — the seam where the main thread hands a run off
 * to whichever execution backend is in force.
 *
 * Phase 1 (this commit) ships only the inline backend — every call goes
 * straight to `runAgent` in the calling process. The shim's value is
 * the indirection itself: every caller routes through `dispatchAgentRun`
 * instead of importing `runAgent` directly, so a future commit can
 * introduce a worker backend behind `agent.execution_isolation`
 * without re-touching every call site.
 *
 * Why this exists: the daemon-loop hardening PR enforced HTTP/event-loop
 * responsiveness by adding `setImmediate` yields in the agent path. That
 * works but is fragile — every new sync hot path on the agent code
 * surface has to remember to yield. Moving agent execution into a
 * `node:worker_threads` worker enforces the property by architecture
 * instead of by discipline. The dispatcher is the integration seam for
 * that future change. See plan `66f6da5b3ca2ed9f`.
 *
 * Coupling to note before introducing a worker backend: the LM Studio
 * ensure-loaded path (`intelligence/lmstudio-instances.ts`) single-flights
 * model loads via a process-local map, which assumes all agent runs share
 * one process. Workers shard that map — concurrent runs in different
 * workers could each load a model instance. That single-flight needs to be
 * hoisted to the daemon side of the seam (or given cross-worker
 * coordination) as part of the worker backend work.
 */

import { runAgent } from './executor.js';
import type { RunOptions, AgentRunResult } from './types.js';

/**
 * Dispatch an agent run. Drop-in replacement for `runAgent` — same
 * signature, same return shape. Internally chooses the configured
 * execution backend (today: always inline).
 *
 * Callers MUST go through this rather than importing `runAgent`
 * directly. Tests that drive the executor in isolation are the one
 * exception — they can still import `runAgent` from `./executor.js`
 * since they care about the inline semantics specifically.
 */
export async function dispatchAgentRun(
  vaultDir: string,
  options?: RunOptions,
): Promise<AgentRunResult> {
  return runAgent(vaultDir, options);
}
