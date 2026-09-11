import type { CaptureRule, SymbiontManifest } from '../symbionts/manifest-schema.js';
import { HOOK_CONFIG } from './hook-config.generated.js';
import { getAtPath } from '../utils/dot-path.js';
import { evaluatePromptRules, evaluateStartRules, type UserPromptRuleContext, type UserPromptDecision, type SessionStartRuleContext, type SessionStartDecision } from '@goondocks/myco-shared/capture-rules';
export { envelopeTagAtStart, isEnclosingEnvelope, type PromptOrigin, type UserPromptRuleContext, type UserPromptDecision, type SessionStartRuleContext, type SessionStartDecision } from '@goondocks/myco-shared/capture-rules';

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
  return evaluatePromptRules(bundles, detectedAgent, ctx);
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
  return evaluateStartRules(bundles, detectedAgent, ctx);
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
