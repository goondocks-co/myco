/**
 * Plan-tag envelope helpers.
 *
 * A symbiont's plan output travels inside XML-style envelopes
 * (`<update_plan>…</update_plan>`, `<proposed_plan>…</proposed_plan>` —
 * tag names come from each manifest's `capture.planTags`). Extraction
 * (`extractTaggedPlans` in daemon/plan-capture.ts) persists the envelope
 * content as Plan records; the response-persist paths must then strip the
 * envelopes so machine-readable plan payloads never leak into user-facing
 * `response_summary` values. Both sides share the envelope regex here so
 * what extraction matches and what stripping removes can never drift.
 */

/** Canonical regex matching every `<tag>…</tag>` plan envelope in a text. */
export function planTagEnvelopeRegex(tag: string): RegExp {
  return new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`, 'g');
}

/**
 * Remove every `<tag>…</tag>` envelope for the given plan tags from `text`,
 * keeping the surrounding prose. Collapses the blank runs left behind and
 * trims the result; an envelope-only text strips to `''` (callers treat
 * that as "no response to persist"). Texts without any envelope are
 * returned unchanged.
 */
export function stripPlanTagEnvelopes(text: string, planTags: readonly string[]): string {
  if (!text || planTags.length === 0) return text;
  let out = text;
  for (const tag of planTags) {
    out = out.replace(planTagEnvelopeRegex(tag), '');
  }
  if (out === text) return text;
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
