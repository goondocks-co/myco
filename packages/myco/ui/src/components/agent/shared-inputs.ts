/**
 * Shared helpers for detecting input identifiers and template variables
 * embedded in a rendered instruction / prompt string.
 *
 * Extracted from `evaluation-helpers.ts` and `rerun-prefill.ts` so both the
 * Comparison view (which summarizes whether multiple runs targeted the same
 * input) and the Rerun pre-fill path (which needs to re-populate per-var
 * inputs) parse the same keys with the same regex.
 */

// ---------------------------------------------------------------------------
// Shared-input identifier extraction
// ---------------------------------------------------------------------------

/**
 * Keys we recognize as "input identifiers" baked into the rendered
 * instruction text. Kept conservative — task prompts that parameterize by
 * one of these values typically render it as `key: value` (YAML-ish) or
 * `key=value` (query-ish) somewhere in the instruction body.
 */
export const SHARED_INPUT_KEYS = ['session_id', 'batch_id', 'target_session'] as const;
export type SharedInputKey = (typeof SHARED_INPUT_KEYS)[number];

/**
 * Regex matching `key: value`, `key = value`, `key: "value"`, `key = 'value'`
 * for the keys listed in SHARED_INPUT_KEYS. The value is either a quoted
 * string (double or single) or a slug-ish unquoted token. The three
 * alternation branches (quoted-dbl / quoted-sgl / unquoted) are captured
 * separately and the consumer picks the first non-empty capture.
 */
export const SHARED_INPUT_PATTERN =
  /\b(session_id|batch_id|target_session)\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/gi;

/**
 * Extract `{ key -> value }` pairs for every recognized shared-input key
 * found in `instruction`. First occurrence wins per key (later references
 * don't overwrite). Returns an empty object when the instruction is null,
 * empty, or contains none of the keys.
 */
export function extractSharedInputs(
  instruction: string | null | undefined,
): Partial<Record<SharedInputKey, string>> {
  const out: Partial<Record<SharedInputKey, string>> = {};
  if (!instruction) return out;
  // Construct per-call so lastIndex state never leaks across invocations.
  const re = new RegExp(SHARED_INPUT_PATTERN.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(instruction)) !== null) {
    const key = match[1]!.toLowerCase() as SharedInputKey;
    // Alternation: exactly one of groups 2/3/4 is populated per match.
    const value = match[2] ?? match[3] ?? match[4];
    if (!value) continue;
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Template-variable extraction
// ---------------------------------------------------------------------------

/**
 * Variables the agent harness always auto-resolves at submit time — they
 * should never be shown as per-var input fields in the Run dialog.
 */
export const AUTO_RESOLVED_VARS = new Set(['instruction']);

export interface ExtractTemplateVarsOptions {
  /**
   * When true, include auto-resolved names (like `instruction`) in the
   * result. Defaults to false — matches the dialog's input-field logic
   * which must exclude harness-managed names.
   */
  includeAutoResolved?: boolean;
}

/**
 * Extract `{{var}}` names from a prompt template. Returns a de-duplicated,
 * insertion-ordered list. By default excludes AUTO_RESOLVED_VARS.
 */
export function extractTemplateVars(
  prompt: string | null | undefined,
  opts: ExtractTemplateVarsOptions = {},
): string[] {
  if (!prompt) return [];
  const { includeAutoResolved = false } = opts;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of prompt.matchAll(/\{\{(\w+)\}\}/g)) {
    const name = m[1]!;
    if (!includeAutoResolved && AUTO_RESOLVED_VARS.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
