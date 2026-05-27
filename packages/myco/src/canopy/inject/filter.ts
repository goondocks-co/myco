/**
 * Intent filter for Canopy PreToolUse/Read injection.
 *
 * The filter encodes the spec's no-injection rules in priority order:
 *   capability_off → disabled → targeted → unknown_file → small_file
 *
 * Each path is exercised individually in tests; the union type makes the
 * reason an explicit, observable signal that flows back to the daemon for
 * later aggregation (canopy_injection_tokens stays NULL when no inject
 * happens, but the reason is derivable from other captured fields per the
 * design's observability section).
 */

import type { CanopyEntry } from '../../db/schema.js';

export type NoInjectionReason =
  | 'capability_off'
  | 'disabled'
  | 'targeted'
  | 'unknown_file'
  | 'small_file'
  /** Per-session per-file dedup gate held — this file was already injected
   * for this session within the current logical run. Set by the injection
   * record helper, not by `decide()`. */
  | 'already_injected';

export interface IntentInput {
  /** PreToolUse `tool_input` payload. We only inspect file_path / offset / limit. */
  toolInput: {
    file_path?: string;
    offset?: number;
    limit?: number;
  };
  /** The CanopyEntry row for `file_path`, or null if no row exists. */
  entry: CanopyEntry | null;
  /** Resolved cortex.canopy.injection settings for the active scope. */
  config: {
    enabled: boolean;
    sizeThreshold: number;
  };
  /** Whether the active symbiont has the preToolUseInjection capability. */
  capabilityOn: boolean;
}

export type IntentDecision =
  | { inject: true; entry: CanopyEntry }
  | { inject: false; reason: NoInjectionReason };

export function decide(input: IntentInput): IntentDecision {
  if (!input.capabilityOn) return { inject: false, reason: 'capability_off' };
  if (!input.config.enabled) return { inject: false, reason: 'disabled' };
  if (input.toolInput.offset != null || input.toolInput.limit != null) {
    return { inject: false, reason: 'targeted' };
  }
  if (!input.entry) return { inject: false, reason: 'unknown_file' };
  if (input.entry.size_bytes < input.config.sizeThreshold) {
    return { inject: false, reason: 'small_file' };
  }
  return { inject: true, entry: input.entry };
}
