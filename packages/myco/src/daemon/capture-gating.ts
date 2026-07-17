/**
 * Shared helper for gating an incoming event (or stop-hook payload) against
 * the per-agent capture rules. Used by `event-dispatch.ts` and
 * `stop-processing.ts` to avoid drift between the two call sites — they
 * both need to read transcript-meta, detect the agent, and call
 * `evaluateSessionCaptureRules` with the same inputs.
 */

import { loadManifests } from '@myco/symbionts/detect.js';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';
import { evaluateSessionCaptureRules, type SessionStartDecision } from '@myco/hooks/capture-rules.js';
import { readTranscriptMeta } from '@myco/hooks/transcript-meta.js';

export interface CaptureGateInput {
  /** Detected agent id (falls back to caller-supplied default if absent). */
  agent: string;
  /** Path to the transcript file supplied by the hook, if any. */
  transcriptPath?: string;
}

export interface CaptureGateResult {
  decision: SessionStartDecision;
  /** True when transcript-meta was successfully read and supplied to the evaluator. */
  hadTranscriptMeta: boolean;
  /**
   * The transcript-meta payload read for this event, when available. Exposed
   * (rather than just the `hadTranscriptMeta` boolean) so callers can run
   * further meta-driven resolution — e.g. `resolveSubagentThread` — without
   * re-reading the transcript file themselves.
   */
  transcriptMeta?: Record<string, unknown>;
}

/**
 * Evaluate the capture rules for an incoming event. Reads transcript meta
 * when a path is supplied, and wraps the evaluator with the standard
 * agent + metadata argument order so both call sites stay in sync.
 *
 * Callers can either pass pre-loaded manifests (hot path / tests) or let
 * this helper load them lazily via `loadManifests()`.
 */
export function gateEventByCaptureRules(
  event: CaptureGateInput,
  options?: { manifests?: SymbiontManifest[] },
): CaptureGateResult {
  const transcriptMeta = event.transcriptPath
    ? readTranscriptMeta(event.transcriptPath) ?? undefined
    : undefined;
  const manifests = options?.manifests ?? loadManifests();
  const decision = evaluateSessionCaptureRules(manifests, event.agent, {
    transcriptPath: event.transcriptPath,
    transcriptMeta,
  });
  return { decision, hadTranscriptMeta: transcriptMeta !== undefined, transcriptMeta };
}
