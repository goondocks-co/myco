/**
 * Phase metadata vault tools.
 *
 * 1 tool: phase_emit_metadata
 *
 * Lets a phase commit a structured key→value to its PhaseResult.metadata
 * so downstream phases can gate on it via
 * `PhaseDefinition.gateOnPriorMetadata`. The phase loop creates a per-
 * phase `metadataAccumulator` Map and passes it via `VaultToolDeps`; the
 * handler writes there.
 *
 * When the accumulator is absent (any non-phase-loop caller), the tool
 * still returns success but values are dropped. That keeps the tool
 * registration simple — no special-case wiring needed for the eager
 * `createVaultToolServer` path or for tests that build a tool surface
 * without phase-loop context.
 */

import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { textResult, type VaultToolDeps } from './types.js';

/** Tools registered by this module. Used for the toolNames gating set. */
export const PHASE_METADATA_TOOL_NAMES = ['phase_emit_metadata'] as const;

export function createPhaseMetadataTools(deps: VaultToolDeps) {
  const phaseEmitMetadata = tool(
    'phase_emit_metadata',
    'Commit a structured key→value to this phase\'s PhaseResult.metadata. Downstream phases may gate on it via gateOnPriorMetadata: { phase, key, equals }. Call once per key; later calls overwrite. Values must be string, number, boolean, or null — no nested objects or arrays in v1.',
    {
      key: z.string().min(1).max(64).describe('Metadata key, e.g. "selectedTier". Stable identifier downstream phases gate on.'),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()])
        .describe('Scalar value committed to PhaseResult.metadata[key].'),
    },
    async (args) => {
      const accumulator = deps.metadataAccumulator;
      if (accumulator) {
        accumulator.set(args.key, args.value);
      }
      // Always return success — the tool's contract is "I accepted your
      // commit." Whether the value persists depends on whether the
      // surrounding phase loop wired in an accumulator (it always does
      // for real runs; tests may not).
      return textResult({
        emitted: true,
        key: args.key,
        value: args.value,
        accumulated: accumulator !== undefined,
      });
    },
    { annotations: { readOnlyHint: true } },
  );

  return [phaseEmitMetadata];
}
