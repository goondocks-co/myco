/**
 * canopy-describe post-processing.
 *
 * LLMs across providers wander in predictable ways: leading boilerplate
 * ("Here is..."), refusal patterns ("I'm sorry"), and lazy
 * exports-verbatim regurgitation. This module mechanically rejects those
 * outputs. The canopy_describe_write tool calls postProcess on every
 * agent submission and rejects rows that come back null.
 *
 * Returning `null` means "this output is unusable". Returning a string
 * means "use this".
 */

// Boilerplate prefixes — match prefix only so the rest of the sentence
// survives stripping. Anchored with `^` so we never delete the same
// phrase mid-sentence.
const BOILERPLATE_PREFIXES: readonly RegExp[] = [
  /^here('| i)s (a |an )?/i,
  /^this file\s+/i,
  /^the (file|module)\s+/i,
  /^summary:\s*/i,
  /^description:\s*/i,
];

// Refusal patterns — if the model said any of these, the output is
// useless regardless of what else surrounded it. Match anywhere in the
// string.
const REFUSAL_PATTERNS: readonly RegExp[] = [
  /i cannot/i,
  /i('| a)m sorry/i,
  /as an ai/i,
];

/**
 * Mechanically clean an LLM output and decide whether it's usable.
 *
 * @param raw            The unprocessed `summarize()` text.
 * @param maxChars       Hard cap on returned length (post-cleanup).
 * @param exportsList    Exports from the canopy_entries row — if the
 *                       cleaned output is exactly one of these, the
 *                       model regurgitated structure instead of meaning.
 *
 * @returns the cleaned, capped string, or `null` if the output should
 *          be rejected.
 */
export function postProcess(
  raw: string,
  maxChars: number,
  exportsList: readonly string[] = [],
): string | null {
  // Whitespace normalization first — collapse newlines and runs of spaces
  // before any pattern checks so anchored regexes line up against the
  // start of the actual sentence.
  let s = raw
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip surrounding straight or curly quotes the model added around its
  // own output. Only paired quotes — leaving in stray inner quotes is
  // fine.
  s = stripWrappingQuotes(s);

  // Strip leading boilerplate, then re-trim. Multiple passes in case the
  // model nested ("Here is a summary: ...").
  for (let i = 0; i < BOILERPLATE_PREFIXES.length * 2; i += 1) {
    let changed = false;
    for (const re of BOILERPLATE_PREFIXES) {
      const next = s.replace(re, '');
      if (next !== s) {
        s = next.trim();
        changed = true;
      }
    }
    if (!changed) break;
  }

  if (!s) return null;

  // Refusal — match anywhere; once the model said it, the rest is noise.
  for (const re of REFUSAL_PATTERNS) {
    if (re.test(s)) return null;
  }

  // Exports-verbatim regurgitation — case-sensitive equality only. We
  // don't lowercase, because exports are identifiers and case matters.
  for (const exportName of exportsList) {
    if (s === exportName) return null;
  }

  // Hard truncation. We don't try to land on a word boundary because the
  // upstream cap is set generously and the model is asked for one
  // sentence; clipping mid-word is a sign the model ignored the rule, in
  // which case the description is already low-quality.
  if (s.length > maxChars) {
    s = s.slice(0, maxChars);
  }

  return s;
}

function stripWrappingQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  const pairs: ReadonlyArray<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ];
  for (const [open, close] of pairs) {
    if (first === open && last === close) {
      return s.slice(1, -1).trim();
    }
  }
  return s;
}
