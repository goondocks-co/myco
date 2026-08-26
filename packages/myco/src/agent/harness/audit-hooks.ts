/**
 * Default HarnessHooks implementation: persists every lifecycle event to
 * agent_run_events. executor.ts wires this in as the default hooks object
 * for every run — event recording is on by default, no per-call opt-in,
 * matching how recordTurn/insertWriteIntent are unconditional today.
 *
 * Best-effort: a broken event-log insert must never fail the tool call or
 * the phase it's observing — same convention as recordTurn (tools.ts) and
 * insertWriteIntent (write-intents.ts).
 */

import type { GroveProjectId } from '@myco/grove/ids.js';
import type { RunStore } from '../runtime/run-store.js';
import type {
  HarnessHooks,
  PreToolUseEvent,
  PostToolUseEvent,
  PhaseStartEvent,
  PhaseEndEvent,
} from './hooks.js';

export function buildAuditEventHooks(
  store: RunStore,
  runId: string,
  projectId: GroveProjectId | null,
): HarnessHooks {
  return {
    async preToolUse(event: PreToolUseEvent) {
      try {
        await store.recordRunEvent({
          runId,
          projectId,
          phaseName: event.phaseName ?? null,
          eventType: 'pre_tool_use',
          toolName: event.toolName,
          payload: JSON.stringify({ toolInput: event.toolInput }),
        });
      } catch {
        /* audit trail is best-effort, same as recordTurn */
      }
    },
    async postToolUse(event: PostToolUseEvent) {
      try {
        await store.recordRunEvent({
          runId,
          projectId,
          phaseName: event.phaseName ?? null,
          eventType: 'post_tool_use',
          toolName: event.toolName,
          outcome: event.outcome,
          durationMs: event.durationMs,
          payload: JSON.stringify({
            toolInput: event.toolInput,
            ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
          }),
        });
      } catch {
        /* audit trail is best-effort */
      }
    },
    async phaseStart(event: PhaseStartEvent) {
      try {
        await store.recordRunEvent({
          runId,
          projectId,
          phaseName: event.phaseName,
          eventType: 'phase_start',
          payload: JSON.stringify({ model: event.model, maxTurns: event.maxTurns, required: event.required }),
        });
      } catch {
        /* audit trail is best-effort */
      }
    },
    async phaseEnd(event: PhaseEndEvent) {
      try {
        await store.recordRunEvent({
          runId,
          projectId,
          phaseName: event.phaseName,
          eventType: 'phase_end',
          outcome: event.status === 'completed' ? 'success' : event.status === 'failed' ? 'error' : null,
          durationMs: event.durationMs,
          payload: JSON.stringify({
            status: event.status,
            turnsUsed: event.turnsUsed,
            tokensUsed: event.tokensUsed,
            costUsd: event.costUsd,
          }),
        });
      } catch {
        /* audit trail is best-effort */
      }
    },
  };
}
