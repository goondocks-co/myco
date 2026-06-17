import { DEFAULT_SYMBIONT_NAME } from '../constants.js';
import { evaluateUserPromptRules, type PromptOrigin } from '../hooks/capture-rules.js';
import { readTranscriptMeta } from '../hooks/transcript-meta.js';
import type { SymbiontManifest } from '../symbionts/manifest-schema.js';

export type CaptureEvent = Record<string, unknown> & {
  type: string;
  session_id: string;
  timestamp: string;
};

export type AcceptedUserPromptNormalization =
  | {
      action: 'pass';
      event: CaptureEvent;
      agent: string;
      ignoredDropReason?: string;
      origin?: PromptOrigin;
    }
  | {
      action: 'rewrite';
      event: CaptureEvent;
      agent: string;
      reason?: string;
      origin?: PromptOrigin;
    };

/**
 * Apply manifest-declared prompt rewrites/classification to a live event that
 * has already passed admission gating.
 *
 * This intentionally ignores `drop` decisions. Drops decide whether a session
 * or prompt should be admitted at hook/registration/replay boundaries; applying
 * them here would let an already-accepted event bypass tombstone and registry
 * contracts in event-dispatch. Rewrites and origins are prompt-preserving
 * normalization, so they are safe and necessary before buffer/DB persistence.
 */
export function normalizeAcceptedUserPromptEvent(
  event: CaptureEvent,
  options: {
    manifests: SymbiontManifest[];
    defaultAgent?: string;
    transcriptMeta?: Record<string, unknown>;
  },
): AcceptedUserPromptNormalization {
  const agent = typeof event.agent === 'string' && event.agent.length > 0
    ? event.agent
    : options.defaultAgent ?? DEFAULT_SYMBIONT_NAME;

  if (event.type !== 'user_prompt') {
    return { action: 'pass', event, agent };
  }

  const prompt = String(event.prompt ?? '');
  const transcriptPath = typeof event.transcript_path === 'string' && event.transcript_path.length > 0
    ? event.transcript_path
    : undefined;
  const transcriptMeta = options.transcriptMeta
    ?? (transcriptPath ? readTranscriptMeta(transcriptPath) ?? undefined : undefined);
  const decision = evaluateUserPromptRules(options.manifests, agent, {
    prompt,
    transcriptPath,
    transcriptMeta,
  });

  if (decision.action === 'drop') {
    return { action: 'pass', event, agent, ignoredDropReason: decision.reason };
  }

  const next: CaptureEvent = decision.action === 'rewrite'
    ? { ...event, prompt: decision.prompt }
    : { ...event };
  if (decision.origin && typeof next.origin !== 'string') {
    next.origin = decision.origin;
  }

  if (decision.action === 'rewrite') {
    return {
      action: 'rewrite',
      event: next,
      agent,
      reason: decision.reason,
      origin: decision.origin,
    };
  }

  return {
    action: 'pass',
    event: next,
    agent,
    origin: decision.origin,
  };
}
