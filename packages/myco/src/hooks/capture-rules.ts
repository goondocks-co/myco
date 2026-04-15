/**
 * Generic capture-rule evaluator.
 *
 * Each symbiont manifest declares `capture.rules` — a list of `{ event,
 * when, action }` records that describe how Myco should filter captured
 * events for that agent. This module loads rules from every manifest
 * in one place and exposes a pure evaluator the hook handlers call
 * without knowing anything symbiont-specific.
 *
 * Adding a new symbiont's capture behavior is a YAML-only change: edit
 * that agent's manifest file, no hook or evaluator changes needed.
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
import { getAtPath } from '../utils/dot-path.js';

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

/** Outcome of evaluating user_prompt rules. */
export type UserPromptDecision =
  | { action: 'pass'; prompt: string }
  | { action: 'rewrite'; prompt: string; reason?: string }
  | { action: 'drop'; reason?: string };

/** Outcome of evaluating session capture rules. No rewrite — there's no prompt text yet. */
export type SessionStartDecision =
  | { action: 'pass' }
  | { action: 'drop'; reason?: string };

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
 */
export function evaluateUserPromptRules(
  manifests: SymbiontManifest[],
  detectedAgent: string,
  ctx: UserPromptRuleContext,
): UserPromptDecision {
  for (const manifest of manifests) {
    const rules = manifest.capture?.rules ?? [];
    for (const rule of rules) {
      if (rule.event !== 'user_prompt') continue;
      if (!scopePermits(rule, manifest.name, detectedAgent)) continue;
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
): SessionStartDecision {
  for (const manifest of manifests) {
    const rules = manifest.capture?.rules ?? [];
    for (const rule of rules) {
      if (rule.event !== 'session_start') continue;
      if (!scopePermits(rule, manifest.name, detectedAgent)) continue;
      if (!whenMatches(rule, { prompt: '', transcriptPath: ctx.transcriptPath, transcriptMeta: ctx.transcriptMeta })) continue;
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
): SessionStartDecision {
  return evaluateSessionStartRules(manifests, detectedAgent, ctx);
}

function scopePermits(rule: CaptureRule, owningAgent: string, detectedAgent: string): boolean {
  if (rule.scope === 'any_agent') return true;
  return owningAgent === detectedAgent;
}

function whenMatches(rule: CaptureRule, ctx: UserPromptRuleContext): boolean {
  const { prompt_starts_with, prompt_contains, transcript_path_missing, transcript_meta_field_exists } = rule.when;

  // Refuse rules with no conditions — prevents a mistyped YAML file from
  // accidentally creating a blanket "drop everything" rule.
  const hasAnyCondition =
    prompt_starts_with !== undefined ||
    prompt_contains !== undefined ||
    transcript_path_missing !== undefined ||
    transcript_meta_field_exists !== undefined;
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

  return true;
}

function applyAction(rule: CaptureRule, ctx: UserPromptRuleContext): UserPromptDecision {
  if (rule.action === 'drop') {
    return { action: 'drop', reason: rule.reason };
  }
  // rewrite_prompt — keep only the substring after the extract_after marker.
  // If the marker isn't in the prompt, fall through to `pass` so we don't
  // accidentally blank out a prompt that turned out not to match after all.
  const marker = rule.extract_after;
  if (!marker) return { action: 'pass', prompt: ctx.prompt };
  const idx = ctx.prompt.indexOf(marker);
  if (idx === -1) return { action: 'pass', prompt: ctx.prompt };
  const after = ctx.prompt.slice(idx + marker.length);
  const next = rule.trim ? after.trim() : after;
  if (!next) return { action: 'pass', prompt: ctx.prompt };
  return { action: 'rewrite', prompt: next, reason: rule.reason };
}
