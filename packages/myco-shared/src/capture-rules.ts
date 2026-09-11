import type { CaptureRule } from './capture-rule-schema.js';
import { getAtPath } from './dot-path.js';

export const DEFAULT_CAPTURE_AGENT = 'claude-code';

export interface CaptureRuleBundle {
  name: string;
  rules: readonly CaptureRule[];
}

export function envelopeTagAtStart(prompt: string, tags: readonly string[]): boolean {
  const s = prompt.trimStart();
  for (const tag of tags) {
    if (!s.startsWith('<' + tag)) continue;
    const next = s.charAt(tag.length + 1);
    if (next === '>' || next === '/' || next === '' || /\s/.test(next)) return true;
  }
  return false;
}
const ENCLOSING_ENVELOPE = /^<([A-Za-z][\w-]*)(\s[^>]*)?>[\s\S]*<\/\1>$|^<([A-Za-z][\w-]*)(\s[^>]*)?\/>$/;

export function isEnclosingEnvelope(prompt: string): boolean {
  return ENCLOSING_ENVELOPE.test(prompt.trim());
}
export interface UserPromptRuleContext {
  prompt: string;
  transcriptPath?: string;
  transcriptMeta?: Record<string, unknown>;
  record?: Record<string, unknown>;
}

export interface SessionStartRuleContext {
  transcriptPath?: string;
  transcriptMeta?: Record<string, unknown>;
}

export type PromptOrigin = 'human' | 'system' | 'agent_dispatch' | 'hook_injected';

export type UserPromptDecision =
  | { action: 'pass'; prompt: string; origin?: PromptOrigin }
  | { action: 'rewrite'; prompt: string; reason?: string; origin?: PromptOrigin }
  | { action: 'drop'; reason?: string };

export type SessionStartDecision =
  | { action: 'pass' }
  | { action: 'drop'; reason?: string };

export function evaluatePromptRules(bundles: readonly CaptureRuleBundle[], detectedAgent: string, ctx: UserPromptRuleContext): UserPromptDecision {
  for (const bundle of bundles) {
    for (const rule of bundle.rules) {
      if (rule.event !== 'user_prompt' || !scopePermits(rule, bundle.name, detectedAgent) || !whenMatches(rule, ctx)) continue;
      return applyAction(rule, ctx);
    }
  }
  return { action: 'pass', prompt: ctx.prompt };
}

export function evaluateStartRules(bundles: readonly CaptureRuleBundle[], detectedAgent: string, ctx: SessionStartRuleContext): SessionStartDecision {
  const promptCtx: UserPromptRuleContext = { prompt: '', transcriptPath: ctx.transcriptPath, transcriptMeta: ctx.transcriptMeta };
  for (const bundle of bundles) {
    for (const rule of bundle.rules) {
      if (rule.event !== 'session_start' || !scopePermits(rule, bundle.name, detectedAgent) || !whenMatches(rule, promptCtx)) continue;
      if (rule.action === 'drop') return { action: 'drop', reason: rule.reason };
    }
  }
  return { action: 'pass' };
}

function scopePermits(rule: CaptureRule, owningAgent: string, detectedAgent: string): boolean {
  if (owningAgent === detectedAgent) return true;
  if (rule.scope !== 'any_agent') return false;
  return detectedAgent === DEFAULT_CAPTURE_AGENT;
}

function whenMatches(rule: CaptureRule, ctx: UserPromptRuleContext): boolean {
  const {
    prompt_starts_with,
    prompt_contains,
    transcript_path_missing,
    transcript_meta_field_exists,
    transcript_meta_field_equals,
    record_field_equals,
    prompt_envelope_tag_in,
    prompt_is_enclosing_envelope,
  } = rule.when;
  const hasAnyCondition =
    prompt_starts_with !== undefined ||
    prompt_contains !== undefined ||
    transcript_path_missing !== undefined ||
    transcript_meta_field_exists !== undefined ||
    transcript_meta_field_equals !== undefined ||
    record_field_equals !== undefined ||
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

  if (record_field_equals !== undefined) {
    if (!ctx.record) return false;
    if (getAtPath(ctx.record, record_field_equals.path) !== record_field_equals.value) {
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
    return { action: 'pass', prompt: ctx.prompt, origin: rule.set_origin };
  }
  if (rule.strip_envelope) {
    const stripped = stripEnvelope(ctx.prompt, rule.strip_envelope.open, rule.strip_envelope.close);
    if (stripped === null) {
      return { action: 'pass', prompt: ctx.prompt, origin: rule.set_origin };
    }
    return { action: 'rewrite', prompt: stripped, reason: rule.reason, origin: rule.set_origin };
  }
  const marker = rule.extract_after;
  if (!marker) return { action: 'pass', prompt: ctx.prompt, origin: rule.set_origin };
  const idx = ctx.prompt.indexOf(marker);
  if (idx === -1) return { action: 'pass', prompt: ctx.prompt, origin: rule.set_origin };
  const after = ctx.prompt.slice(idx + marker.length);
  const next = rule.trim ? after.trim() : after;
  if (!next) return { action: 'pass', prompt: ctx.prompt, origin: rule.set_origin };
  return { action: 'rewrite', prompt: next, reason: rule.reason, origin: rule.set_origin };
}
function stripEnvelope(prompt: string, open: string, close: string): string | null {
  if (!prompt.startsWith(open) || !prompt.endsWith(close)) return null;
  if (prompt.length < open.length + close.length) return null;
  const inner = prompt
    .slice(open.length, prompt.length - close.length)
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');
  return inner.length > 0 ? inner : null;
}
