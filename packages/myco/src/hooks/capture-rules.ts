/**
 * Generic capture-rule evaluator.
 *
 * Each symbiont manifest declares `capture.rules` — a list of `{ event,
 * when, action }` records that describe how Myco should filter captured
 * events for that agent. This module reads rules from the build-time
 * generated hook-config (`hook-config.generated.ts`) and exposes a pure
 * evaluator the hook handlers call without knowing anything symbiont-specific.
 *
 * Adding a new symbiont's capture behavior is still a YAML-only change:
 * edit that agent's manifest, run `npm run codegen` (or let the build do
 * it for you), and the evaluator sees the new rules. No hook or evaluator
 * changes needed.
 *
 * Rule scope (`this_agent` vs `any_agent`) lets rules opt into running
 * even when agent detection itself fails — useful for ephemeral
 * sub-invocations that legitimately lack the signals we key on.
 *
 * Conditions should prefer structural signals (e.g.,
 * `transcript_path_missing`) over text matching so rules stay robust
 * across upstream agent updates.
 */

import type { CaptureRule, SymbiontManifest } from '../symbionts/manifest-schema.js';
import { HOOK_CONFIG } from './hook-config.generated.js';
import { getAtPath } from '../utils/dot-path.js';
import { DEFAULT_SYMBIONT_NAME } from '../constants.js';

/**
 * Matches the tag NAME at the start of the (trimmed) prompt, ignoring attributes,
 * so a tag with attributes like `from="…"` still matches. Start-match (not
 * whole-message) so it also catches prefix-style envelopes. Returns true if
 * `prompt` begins with `<tag` for any tag in `tags`.
 */
export function envelopeTagAtStart(prompt: string, tags: readonly string[]): boolean {
  const s = prompt.trimStart();
  for (const tag of tags) {
    if (!s.startsWith('<' + tag)) continue;
    const next = s.charAt(tag.length + 1);
    if (next === '>' || next === '/' || next === '' || /\s/.test(next)) return true;
  }
  return false;
}

// Whole trimmed message is one balanced (or self-closing) envelope. Greedy to
// the LAST matching close-tag (nested same-tag whole-message envelopes match);
// attributes containing '>' are handled for the open/close form; the self-closing
// form does not support '>' inside attributes (fails toward human, which is safe);
// Known limitation: two sibling same-name tags concatenated also match and would
// be classified non-human under the fail-safe — an accepted case within the
// fail-safe's hide-by-default tradeoff (content is preserved, just hidden).
// No catastrophic backtracking.
const ENCLOSING_ENVELOPE = /^<([A-Za-z][\w-]*)(\s[^>]*)?>[\s\S]*<\/\1>$|^<([A-Za-z][\w-]*)(\s[^>]*)?\/>$/;

/** True when the ENTIRE trimmed prompt is a single XML envelope (fail-safe classifier). */
export function isEnclosingEnvelope(prompt: string): boolean {
  return ENCLOSING_ENVELOPE.test(prompt.trim());
}

/** Structured context a rule can match against at UserPromptSubmit time. */
export interface UserPromptRuleContext {
  /** The user prompt text as received from the hook. */
  prompt: string;
  /** Transcript path from the hook payload, if any. Empty/undefined signals an ephemeral session. */
  transcriptPath?: string;
  /** Parsed first JSON line (session_meta) from the transcript, if available. */
  transcriptMeta?: Record<string, unknown>;
}

/** Structured context a rule can match against at SessionStart time. */
export interface SessionStartRuleContext {
  /** Transcript path from the hook payload, if any. Empty/undefined signals an ephemeral session. */
  transcriptPath?: string;
  /** Parsed first JSON line (session_meta) from the transcript, if available. */
  transcriptMeta?: Record<string, unknown>;
}

/**
 * Outcome of evaluating user_prompt rules.
 *
 * `origin` is optional on pass/rewrite decisions — when set, the prompt is
 * captured but tagged with a non-default origin. The walker copies it onto
 * the resulting UserPromptRecord so the writer persists it on the batch.
 *
 * Origin values mirror PROMPT_BATCH_ORIGIN in db/queries/batches.ts:
 *   'human' (default), 'system', 'agent_dispatch', 'hook_injected'.
 */
export type PromptOrigin = 'human' | 'system' | 'agent_dispatch' | 'hook_injected';

export type UserPromptDecision =
  | { action: 'pass'; prompt: string; origin?: PromptOrigin }
  | { action: 'rewrite'; prompt: string; reason?: string; origin?: PromptOrigin }
  | { action: 'drop'; reason?: string };

/** Outcome of evaluating session capture rules. No rewrite — there's no prompt text yet. */
export type SessionStartDecision =
  | { action: 'pass' }
  | { action: 'drop'; reason?: string };

/**
 * Internal shape the evaluator iterates. Legacy callers pass full
 * SymbiontManifest[] (because that's what loadManifests() returns); we
 * only ever read `name` and `capture.rules` off it. Generated callers
 * pass the same pair harvested from HOOK_CONFIG directly.
 */
interface RuleBundle {
  name: string;
  rules: CaptureRule[];
}

function bundlesFromManifests(manifests: ReadonlyArray<SymbiontManifest>): RuleBundle[] {
  return manifests.map((m) => ({ name: m.name, rules: m.capture?.rules ?? [] }));
}

/**
 * Default rule source for hook-time callers who don't pass manifests.
 * Computed once per process at module load; since this module is only
 * imported inside short-lived hook processes, this is a constant-time
 * cost and avoids re-walking HOOK_CONFIG on every evaluate() call.
 */
const GENERATED_BUNDLES: RuleBundle[] = Object.entries(HOOK_CONFIG).map(
  ([name, entry]) => ({ name, rules: entry.captureRules ?? [] }),
);

/**
 * Evaluate all user_prompt rules from every manifest against one context.
 *
 * Rules are checked in declaration order, first-match-wins. A rule only
 * fires when:
 *   1. its `event` is `user_prompt`,
 *   2. its scope permits it (see scope semantics in manifest-schema.ts),
 *   3. every condition in its `when` block matches the context.
 *
 * If no rule matches, the prompt passes through unchanged.
 *
 * Overloaded for compatibility:
 *   - Legacy callers pass `(manifests, detectedAgent, ctx)`.
 *   - Hook-hot-path callers can pass `(detectedAgent, ctx)` to read rules
 *     from the build-time generated config and skip the YAML+Zod load.
 */
export function evaluateUserPromptRules(
  manifests: SymbiontManifest[],
  detectedAgent: string,
  ctx: UserPromptRuleContext,
): UserPromptDecision;
export function evaluateUserPromptRules(
  detectedAgent: string,
  ctx: UserPromptRuleContext,
): UserPromptDecision;
export function evaluateUserPromptRules(
  manifestsOrAgent: SymbiontManifest[] | string,
  ctxOrAgent: UserPromptRuleContext | string,
  maybeCtx?: UserPromptRuleContext,
): UserPromptDecision {
  const { bundles, detectedAgent, ctx } = resolveArgs<UserPromptRuleContext>(
    manifestsOrAgent,
    ctxOrAgent,
    maybeCtx,
  );
  for (const bundle of bundles) {
    for (const rule of bundle.rules) {
      if (rule.event !== 'user_prompt') continue;
      if (!scopePermits(rule, bundle.name, detectedAgent)) continue;
      if (!whenMatches(rule, ctx)) continue;
      return applyAction(rule, ctx);
    }
  }
  return { action: 'pass', prompt: ctx.prompt };
}

/**
 * Evaluate all session_start rules from every manifest.
 *
 * Same first-match-wins semantics as user_prompt rules. The only action
 * session_start rules can take is `drop` — text rewriting doesn't apply
 * because there's no prompt text at SessionStart time. Rules that
 * specify prompt-based conditions (prompt_starts_with / prompt_contains)
 * match against an empty prompt here, so they'll never fire on the
 * session_start pass.
 *
 * Callers should skip session registration when the result is `drop`.
 */
export function evaluateSessionStartRules(
  manifests: SymbiontManifest[],
  detectedAgent: string,
  ctx: SessionStartRuleContext,
): SessionStartDecision;
export function evaluateSessionStartRules(
  detectedAgent: string,
  ctx: SessionStartRuleContext,
): SessionStartDecision;
export function evaluateSessionStartRules(
  manifestsOrAgent: SymbiontManifest[] | string,
  ctxOrAgent: SessionStartRuleContext | string,
  maybeCtx?: SessionStartRuleContext,
): SessionStartDecision {
  const { bundles, detectedAgent, ctx } = resolveArgs<SessionStartRuleContext>(
    manifestsOrAgent,
    ctxOrAgent,
    maybeCtx,
  );
  const promptCtx: UserPromptRuleContext = {
    prompt: '',
    transcriptPath: ctx.transcriptPath,
    transcriptMeta: ctx.transcriptMeta,
  };
  for (const bundle of bundles) {
    for (const rule of bundle.rules) {
      if (rule.event !== 'session_start') continue;
      if (!scopePermits(rule, bundle.name, detectedAgent)) continue;
      if (!whenMatches(rule, promptCtx)) continue;
      if (rule.action === 'drop') {
        return { action: 'drop', reason: rule.reason };
      }
      // rewrite_prompt is meaningless at session_start — skip and let
      // later rules have a chance to match.
    }
  }
  return { action: 'pass' };
}

/**
 * Evaluate whether a session should be materialized at a lifecycle boundary.
 *
 * SessionStart uses this before registering a session row. Stop processing uses
 * the same decision before transcript-backed capture or stop-driven
 * auto-registration. Keeping both boundaries on the same manifest-driven
 * evaluator makes the rule sustainable for every symbiont, not just the one
 * that first exposed the gap.
 */
export function evaluateSessionCaptureRules(
  manifests: SymbiontManifest[],
  detectedAgent: string,
  ctx: SessionStartRuleContext,
): SessionStartDecision;
export function evaluateSessionCaptureRules(
  detectedAgent: string,
  ctx: SessionStartRuleContext,
): SessionStartDecision;
export function evaluateSessionCaptureRules(
  manifestsOrAgent: SymbiontManifest[] | string,
  ctxOrAgent: SessionStartRuleContext | string,
  maybeCtx?: SessionStartRuleContext,
): SessionStartDecision {
  // Delegate to evaluateSessionStartRules with whichever overload was passed.
  if (typeof manifestsOrAgent === 'string') {
    return evaluateSessionStartRules(manifestsOrAgent, ctxOrAgent as SessionStartRuleContext);
  }
  return evaluateSessionStartRules(manifestsOrAgent, ctxOrAgent as string, maybeCtx as SessionStartRuleContext);
}

/**
 * Disambiguate the two overload forms. When the first arg is a string it
 * is the detected agent and rules come from the generated config. When it
 * is an array it is the legacy manifests list.
 */
function resolveArgs<Ctx>(
  manifestsOrAgent: SymbiontManifest[] | string,
  ctxOrAgent: Ctx | string,
  maybeCtx: Ctx | undefined,
): { bundles: RuleBundle[]; detectedAgent: string; ctx: Ctx } {
  if (typeof manifestsOrAgent === 'string') {
    return {
      bundles: GENERATED_BUNDLES,
      detectedAgent: manifestsOrAgent,
      ctx: ctxOrAgent as Ctx,
    };
  }
  return {
    bundles: bundlesFromManifests(manifestsOrAgent),
    detectedAgent: ctxOrAgent as string,
    ctx: maybeCtx as Ctx,
  };
}

/**
 * `any_agent` scope lets a manifest's rule fire even when its own agent isn't
 * the detected one — designed for phantom sub-invocations that arrive with
 * ambiguous attribution. Detection falls back to `DEFAULT_SYMBIONT_NAME` when
 * it fails (see normalize.ts and event-dispatch.ts), so `any_agent` only
 * crosses the agent boundary in that exact case. Events carrying a specific
 * non-default agent (e.g., plugin-delivered `agent: "opencode"`) are trusted
 * attribution and must not be touched by another manifest's `any_agent` rules
 * — otherwise codex's phantom-drop rule contaminates opencode, silently
 * dropping every event for any opencode session whose registry was lost.
 */
function scopePermits(rule: CaptureRule, owningAgent: string, detectedAgent: string): boolean {
  if (owningAgent === detectedAgent) return true;
  if (rule.scope !== 'any_agent') return false;
  return detectedAgent === DEFAULT_SYMBIONT_NAME;
}

function whenMatches(rule: CaptureRule, ctx: UserPromptRuleContext): boolean {
  const {
    prompt_starts_with,
    prompt_contains,
    transcript_path_missing,
    transcript_meta_field_exists,
    transcript_meta_field_equals,
    prompt_envelope_tag_in,
    prompt_is_enclosing_envelope,
  } = rule.when;

  // Refuse rules with no conditions — prevents a mistyped YAML file from
  // accidentally creating a blanket "drop everything" rule.
  const hasAnyCondition =
    prompt_starts_with !== undefined ||
    prompt_contains !== undefined ||
    transcript_path_missing !== undefined ||
    transcript_meta_field_exists !== undefined ||
    transcript_meta_field_equals !== undefined ||
    prompt_envelope_tag_in !== undefined ||
    prompt_is_enclosing_envelope !== undefined;
  if (!hasAnyCondition) return false;

  if (prompt_starts_with && !ctx.prompt.startsWith(prompt_starts_with)) return false;
  if (prompt_contains && !ctx.prompt.includes(prompt_contains)) return false;

  if (transcript_path_missing !== undefined) {
    const missing = !ctx.transcriptPath || ctx.transcriptPath.length === 0;
    if (transcript_path_missing && !missing) return false;
    if (!transcript_path_missing && missing) return false;
  }

  if (transcript_meta_field_exists !== undefined) {
    if (!ctx.transcriptMeta) return false;
    if (!getAtPath(ctx.transcriptMeta, transcript_meta_field_exists)) return false;
  }

  if (transcript_meta_field_equals !== undefined) {
    if (!ctx.transcriptMeta) return false;
    if (getAtPath(ctx.transcriptMeta, transcript_meta_field_equals.path) !== transcript_meta_field_equals.value) {
      return false;
    }
  }

  if (prompt_envelope_tag_in !== undefined) {
    if (!envelopeTagAtStart(ctx.prompt, prompt_envelope_tag_in)) return false;
  }
  if (prompt_is_enclosing_envelope !== undefined) {
    if (prompt_is_enclosing_envelope !== isEnclosingEnvelope(ctx.prompt)) return false;
  }

  return true;
}

function applyAction(rule: CaptureRule, ctx: UserPromptRuleContext): UserPromptDecision {
  if (rule.action === 'drop') {
    return { action: 'drop', reason: rule.reason };
  }
  if (rule.action === 'classify') {
    // Capture the prompt as-is but tag it with a non-default origin. A rule
    // that uses `classify` without `set_origin` is a no-op (defaults to
    // 'human'), so the schema makes set_origin optional but practically
    // pointless to omit.
    return { action: 'pass', prompt: ctx.prompt, origin: rule.set_origin };
  }
  // rewrite_prompt + strip_envelope — remove a single enclosing tag pair
  // (e.g. Cursor's `<user_query>…</user_query>` wrapper, new app payload
  // behavior observed 2026-06-11). Strips ONLY when both tags are present;
  // the inner text is kept verbatim apart from the whitespace adjacent to
  // the tags, which belongs to the envelope. Idempotent: a stripped prompt
  // no longer starts with the open tag, so re-evaluation passes through.
  //
  // Convergence note: prompts stored BEFORE this rule shipped carry the
  // wrapper, while new buffers strip it — so a session spanning the upgrade
  // can replay-mismatch on the first-256-chars dedupe key. The prefix
  // second-chance match won't bridge it either, since the wrapper changes
  // the head of the text. Accepted: the window is one session generation.
  if (rule.strip_envelope) {
    const stripped = stripEnvelope(ctx.prompt, rule.strip_envelope.open, rule.strip_envelope.close);
    if (stripped === null) {
      return { action: 'pass', prompt: ctx.prompt, origin: rule.set_origin };
    }
    return { action: 'rewrite', prompt: stripped, reason: rule.reason, origin: rule.set_origin };
  }
  // rewrite_prompt — keep only the substring after the extract_after marker.
  // If the marker isn't in the prompt, fall through to `pass` so we don't
  // accidentally blank out a prompt that turned out not to match after all.
  const marker = rule.extract_after;
  if (!marker) return { action: 'pass', prompt: ctx.prompt, origin: rule.set_origin };
  const idx = ctx.prompt.indexOf(marker);
  if (idx === -1) return { action: 'pass', prompt: ctx.prompt, origin: rule.set_origin };
  const after = ctx.prompt.slice(idx + marker.length);
  const next = rule.trim ? after.trim() : after;
  if (!next) return { action: 'pass', prompt: ctx.prompt, origin: rule.set_origin };
  return { action: 'rewrite', prompt: next, reason: rule.reason, origin: rule.set_origin };
}

/** Resolved sub-agent thread identity for a transcript. */
export interface SubagentThreadInfo {
  /** The PARENT thread/session id this sub-agent thread was spawned from. */
  parentSessionId: string;
  /** The sub-agent thread's own stable id, or null when the agent declares no `subagentThreadIdPath` or it doesn't resolve. */
  threadId: string | null;
  /** Human-friendly label for the thread — nickname, else the last path segment — or null when neither resolves. */
  threadLabel: string | null;
}

/**
 * Sub-agent thread info for a transcript, or null when the agent declares no
 * `subagentParentPath` or the path doesn't resolve to a non-empty string.
 * Locations are manifest-declared dot-paths (relative to the transcript's
 * session_meta payload, the same object `transcript_meta_field_exists`
 * reads) — no agent shape is hardcoded here.
 *
 * Label derivation (`agent_nickname` when non-empty, else the last
 * `/`-separated segment of `agent_path`) lives here in code because a
 * single dot-path can't express a fallback; `subagentLabelPath` only
 * points at the OBJECT that carries both fields.
 */
export function resolveSubagentThread(
  detectedAgent: string,
  meta: Record<string, unknown> | undefined,
): SubagentThreadInfo | null {
  if (!meta) return null;
  const entry = HOOK_CONFIG[detectedAgent];
  const parentPath = entry?.subagentParentPath;
  if (!parentPath) return null;

  const parent = getAtPath(meta, parentPath);
  if (typeof parent !== 'string' || parent.length === 0) return null;

  let threadId: string | null = null;
  if (entry.subagentThreadIdPath) {
    const value = getAtPath(meta, entry.subagentThreadIdPath);
    if (typeof value === 'string' && value.length > 0) threadId = value;
  }

  let threadLabel: string | null = null;
  if (entry.subagentLabelPath) {
    const labelSource = getAtPath(meta, entry.subagentLabelPath);
    threadLabel = deriveSubagentLabel(labelSource);
  }

  return { parentSessionId: parent, threadId, threadLabel };
}

/**
 * Derive a human-friendly thread label from the sub-agent-spawn object:
 * prefer `agent_nickname` when it's a non-empty string, else fall back to
 * the last `/`-separated segment of `agent_path`. Returns null when
 * neither field resolves to something usable.
 */
function deriveSubagentLabel(labelSource: unknown): string | null {
  if (!labelSource || typeof labelSource !== 'object') return null;
  const { agent_nickname: nickname, agent_path: agentPath } = labelSource as Record<string, unknown>;
  if (typeof nickname === 'string' && nickname.length > 0) return nickname;
  if (typeof agentPath === 'string' && agentPath.length > 0) {
    const segments = agentPath.split('/').filter((s) => s.length > 0);
    if (segments.length > 0) return segments[segments.length - 1]!;
  }
  return null;
}

/**
 * Strip a single `open`…`close` envelope from a prompt. Returns the inner
 * text, or null when the envelope isn't fully present (only one tag, tags
 * out of order, or an empty interior — never blank out a prompt).
 */
function stripEnvelope(prompt: string, open: string, close: string): string | null {
  if (!prompt.startsWith(open) || !prompt.endsWith(close)) return null;
  if (prompt.length < open.length + close.length) return null;
  const inner = prompt
    .slice(open.length, prompt.length - close.length)
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');
  return inner.length > 0 ? inner : null;
}
