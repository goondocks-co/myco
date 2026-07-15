/**
 * Classify user prompts as initial / steering / interrupt by walking the
 * transcript under each symbiont's manifest-declared `capture.prompts` rules.
 */

import { getAtPath, unsetAtPath } from '../utils/dot-path.js';
import { evaluateUserPromptRules, type PromptOrigin, type UserPromptDecision } from '../hooks/capture-rules.js';
import { HOOK_CONFIG } from '../hooks/hook-config.generated.js';
import { extractCodexPromptText } from '../symbionts/parsers/codex-jsonl.js';
import type {
  CapturePrompts,
  MatchExpression,
  PromptShape,
  ResetBoundary,
} from '../symbionts/manifest-schema.js';

export const CLAUDE_INTERRUPT_MARKER = '[Request interrupted by user for tool use]';
export const CODEX_INTERRUPT_MARKER = '<turn_aborted>';

const UNINITIALIZED = Symbol('uninitialized');

export interface UserPromptRecord {
  /** Conversation-flow position: 'initial' | 'steering' | 'interrupt'. */
  kind: string;
  /**
   * Provenance of the prompt — orthogonal to `kind`. Default 'human'.
   * Set to 'system' / 'agent_dispatch' / 'hook_injected' by capture rules
   * matching transcript-synthesized envelopes (e.g. <task-notification>,
   * <subagent_notification>, <environment_context>, <skill>).
   */
  origin: PromptOrigin;
  text: string;
}

export type { UserPromptRecord as PromptRecord };

/** Options that change how the walker dispositions prompts. */
export interface WalkerOptions {
  /**
   * Sub-agent reattribution context: this transcript is a resolved sub-agent
   * thread being mined INTO its parent session as thread-scoped batches. In
   * this mode the walker does NOT honor the manifest's sub-agent-thread drop
   * rule (the `user_prompt` drop whose `transcript_meta_field_exists` roots
   * `subagentParentPath`) — it masks that meta subtree before evaluating, so
   * those turns survive as records instead of being dropped. Every OTHER drop
   * rule (exec `source == exec`, the AGENTS.md injection prefix) still fires,
   * and every surviving record is stamped `origin = 'agent_dispatch'` so it is
   * born-closed and never claims the human steering anchor. Gated by the
   * structural "parent resolved" signal — never a rule's editable `reason`.
   */
  subagentReattribution?: boolean;
}

/** Return a kind per user prompt seen in the transcript, in order. */
export function extractUserPromptKinds(
  agent: string,
  events: ReadonlyArray<Record<string, unknown>>,
  transcriptPath?: string,
): string[] {
  return extractUserPromptRecords(agent, events, transcriptPath).map((r) => r.kind);
}

export function extractUserPromptRecords(
  agent: string,
  events: ReadonlyArray<Record<string, unknown>>,
  transcriptPath?: string,
  transcriptMeta?: Record<string, unknown>,
): UserPromptRecord[] {
  const config = HOOK_CONFIG[agent]?.capturePrompts;
  if (!config) return [];
  return walkTranscript(config, agent, events, transcriptPath, transcriptMeta).records;
}

/**
 * Like {@link extractUserPromptRecords} but also returns the raw text of
 * prompts that a capture.rules `drop` decision suppressed. Reconcile uses the
 * dropped list to distinguish a DB batch with no transcript peer (real drift,
 * worth warning about) from one whose transcript peer the walker intentionally
 * dropped (e.g., Claude Code's <command-message> dispatch envelope).
 */
export function extractUserPromptRecordsWithDrops(
  agent: string,
  events: ReadonlyArray<Record<string, unknown>>,
  transcriptPath?: string,
  transcriptMeta?: Record<string, unknown>,
  options?: WalkerOptions,
): { records: UserPromptRecord[]; droppedText: string[]; noMaskableDropRuleFound: boolean } {
  const config = HOOK_CONFIG[agent]?.capturePrompts;
  if (!config) return { records: [], droppedText: [], noMaskableDropRuleFound: false };
  const result = walkTranscript(config, agent, events, transcriptPath, transcriptMeta, options);
  return { records: result.records, droppedText: result.droppedText, noMaskableDropRuleFound: result.noMaskableDropRuleFound };
}

/** Classify a hypothetical next prompt given current transcript state + text. */
export function classifyNextPromptKind(
  agent: string | undefined,
  events: ReadonlyArray<Record<string, unknown>>,
  prompt: string,
): string {
  const config = agent ? HOOK_CONFIG[agent]?.capturePrompts : undefined;
  if (!config || !agent) return 'initial';
  if (config.interruptMarker && prompt.startsWith(config.interruptMarker)) {
    return 'interrupt';
  }
  return walkTranscript(config, agent, events, undefined).priorTurnEnded ? 'initial' : 'steering';
}

/**
 * Classify the origin of a hypothetical next prompt. Returns 'human' when no
 * rule matches — system/agent_dispatch only fire on transcript-synthesized
 * envelopes the manifest rules tag explicitly.
 */
export function classifyNextPromptOrigin(
  agent: string | undefined,
  prompt: string,
  transcriptPath?: string,
): PromptOrigin {
  const decision = classifyNextPromptDecision(agent, prompt, transcriptPath);
  if (decision.action === 'drop') return 'human';
  return decision.origin ?? 'human';
}

/**
 * Full manifest decision for a hypothetical next prompt — the drop-aware
 * superset of {@link classifyNextPromptOrigin}. Buffer replay/reconciliation
 * uses this so a buffered envelope the manifest would DROP (e.g. a
 * `<command-name>` / `<local-command-stdout>` from a pre-rule buffer file) is
 * suppressed rather than collapsed to an origin='human' prompt the user never
 * typed. Returns a pass decision when the agent is unknown (nothing to match).
 */
export function classifyNextPromptDecision(
  agent: string | undefined,
  prompt: string,
  transcriptPath?: string,
): UserPromptDecision {
  if (!agent) return { action: 'pass', prompt, origin: 'human' };
  return evaluateUserPromptRules(
    agent,
    { prompt, transcriptPath: transcriptPath ?? '<transcript-walker>' },
  );
}

// ---------------------------------------------------------------------------
// Generic walker
// ---------------------------------------------------------------------------

interface WalkResult {
  records: UserPromptRecord[];
  /** Raw text of prompts that a `drop` rule suppressed; used by reconcile to silence false stranded-batch warnings. */
  droppedText: string[];
  priorTurnEnded: boolean;
  /**
   * True only when `subagentReattribution` was requested but
   * {@link maskSubagentDropMeta} found no ancestor drop-rule path to
   * neutralize (unknown agent, no declared `subagentParentPath`, or no
   * `user_prompt` drop rule keyed on it). In that state every prompt still
   * hits the live sub-agent-thread drop rule, so reattribution silently mines
   * zero rows — the caller (which owns a logger) should surface this.
   */
  noMaskableDropRuleFound: boolean;
}

/**
 * Walk transcript events and emit `{kind, text}` per user prompt. Kind is
 * position-only: `initial` when the walker considers the turn closed,
 * `steering` when mid-turn, `interrupt` on the configured marker prefix.
 */
function walkTranscript(
  config: CapturePrompts,
  agent: string,
  events: ReadonlyArray<Record<string, unknown>>,
  transcriptPath: string | undefined,
  transcriptMeta?: Record<string, unknown>,
  options?: WalkerOptions,
): WalkResult {
  const seenDedupe = new Set<string>();
  const records: UserPromptRecord[] = [];
  const droppedText: string[] = [];
  let priorTurnEnded = true;

  // In the sub-agent reattribution context the sub-agent-thread drop must be
  // suppressed while every other drop rule stays live. Masking the meta
  // subtree the drop keys on (rather than the first-matched rule) is what
  // keeps exec / AGENTS.md drops working even though the sub-agent drop rule
  // is declared BEFORE them and would otherwise shadow them.
  const reattribute = options?.subagentReattribution === true;
  const mask = reattribute ? maskSubagentDropMeta(agent, transcriptMeta) : undefined;
  const evalMeta = reattribute ? mask!.meta : transcriptMeta;
  // Only meaningful when reattribution was requested — an agent whose
  // sub-agent drop keys differently (or a manifest missing
  // `subagentParentPath` altogether) leaves the live drop rule live, so every
  // prompt in this transcript would be dropped instead of reattributed.
  const noMaskableDropRuleFound = reattribute && !mask!.maskedAny;

  // Each reset-boundary with `changeOn` remembers its last seen value so
  // repeated matches with an unchanged value don't re-reset the walker.
  const changeOnState = new Map<ResetBoundary, unknown>();

  for (const event of events) {
    if (matchesAnyResetBoundary(config.resetBoundaries, event, changeOnState)) {
      priorTurnEnded = true;
      continue;
    }

    const shape = findMatchingShape(config.shapes, event);
    if (!shape) continue;

    if (shape.dedupeBy) {
      const key = toKey(shape.name ?? shape.match.type, getAtPath(event, shape.dedupeBy));
      if (seenDedupe.has(key)) continue;
      seenDedupe.add(key);
    }

    const rawText = extractText(event, shape);
    if (!rawText) continue;

    // Apply manifest capture.rules identically to the live hook path. A
    // synthetic transcriptPath is used when none was supplied so structural
    // rules keyed on `transcript_path_missing` don't mis-fire during mining.
    // `transcriptMeta` (the transcript's session_meta payload, when the
    // caller read it) makes `transcript_meta_*` rules fire at mining time
    // exactly as they do at hook time — without it every such rule was
    // structurally inert on this path (capture-rules requires meta present).
    // evaluateUserPromptRules now reads from the generated hook-config by
    // default — no loadManifests() call on the mining path either.
    const decision = evaluateUserPromptRules(
      agent,
      {
        prompt: rawText,
        transcriptPath: transcriptPath ?? '<transcript-walker>',
        transcriptMeta: evalMeta,
      },
    );
    if (decision.action === 'drop') {
      droppedText.push(rawText);
      continue;
    }
    const text = decision.action === 'rewrite' ? decision.prompt : rawText;
    // Every record that survives the reattribution walk is a sub-agent turn:
    // stamp agent_dispatch regardless of what per-record rules said, so the
    // reconcile inserts it born-closed and it never becomes a human anchor.
    const origin: PromptOrigin = reattribute ? 'agent_dispatch' : (decision.origin ?? 'human');

    const kind = config.interruptMarker && text.startsWith(config.interruptMarker)
      ? 'interrupt'
      : priorTurnEnded
        ? 'initial'
        : 'steering';

    records.push({ kind, origin, text });
    priorTurnEnded = false;
  }

  return { records, droppedText, priorTurnEnded, noMaskableDropRuleFound };
}

function findMatchingShape(
  shapes: ReadonlyArray<PromptShape>,
  event: Record<string, unknown>,
): PromptShape | undefined {
  for (const shape of shapes) {
    if (!matchExpression(shape.match, event)) continue;
    // Content-prefix guard: when a shape declares `textStartsWith`, its
    // structurally-identical siblings (e.g. lead prompts / command artifacts
    // that share every top-level field with a teammate-message) are excluded
    // by inspecting the resolved text. Falls through to the next shape so the
    // generic user_prompt shape still claims those entries.
    if (shape.textStartsWith && !extractText(event, shape).startsWith(shape.textStartsWith)) {
      continue;
    }
    return shape;
  }
  return undefined;
}

function matchesAnyResetBoundary(
  boundaries: ReadonlyArray<ResetBoundary>,
  event: Record<string, unknown>,
  state: Map<ResetBoundary, unknown>,
): boolean {
  for (const boundary of boundaries) {
    if (!matchExpression(boundary.match, event)) continue;
    if (!boundary.changeOn) return true;
    const value = getAtPath(event, boundary.changeOn);
    const prev = state.has(boundary) ? state.get(boundary) : UNINITIALIZED;
    state.set(boundary, value);
    if (value !== prev) return true;
  }
  return false;
}

function matchExpression(match: MatchExpression, event: Record<string, unknown>): boolean {
  if (event.type !== match.type) return false;
  if (match.hasField) {
    const v = getAtPath(event, match.hasField);
    if (v === undefined || v === null || v === '' || v === false) return false;
  }
  if (match.fieldEquals) {
    for (const [path, expected] of Object.entries(match.fieldEquals)) {
      if (getAtPath(event, path) !== expected) return false;
    }
  }
  if (match.fieldNotEquals) {
    for (const [path, forbidden] of Object.entries(match.fieldNotEquals)) {
      if (getAtPath(event, path) === forbidden) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/**
 * Resolve the shape's `textAt` path against `event` and coerce to text.
 * Plain strings pass through. Arrays follow the shape's `textExtraction`
 * mode: `joined_text_parts` delegates to the canonical Codex routine shared
 * with the transcript parser (wrapper-tag strip + join — walker and parser
 * must derive identical text for response prefix-matching); the default
 * `first_text` returns the first `{type:"text"}` block (Claude Code shape).
 */
function extractText(event: Record<string, unknown>, shape: PromptShape): string {
  const value = getAtPath(event, shape.textAt);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (shape.textExtraction === 'joined_text_parts') {
      return extractCodexPromptText(value);
    }
    const textBlock = value.find(
      (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text',
    ) as { text?: unknown } | undefined;
    const text = textBlock?.text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

function toKey(scope: string, value: unknown): string {
  return `${scope}|${String(value)}`;
}

/**
 * Return a copy of the transcript meta with every sub-agent-thread drop
 * condition neutralized, for the reattribution mining context.
 *
 * A sub-agent-thread drop rule is a `user_prompt` `drop` whose
 * `transcript_meta_field_exists` path roots the manifest's
 * `subagentParentPath` — e.g. codex's `source.subagent`, an ancestor of
 * `source.subagent.thread_spawn.parent_thread_id`. Deleting that subtree from
 * the meta the walker evaluates against makes the sub-agent drop stop matching
 * while leaving every other rule free to fire against the real prompt/meta:
 * the exec drop (`transcript_meta_field_equals: source == exec`) still sees a
 * non-'exec' source, and the AGENTS.md-injection drop (a prompt prefix) is
 * meta-independent. The match is structural — keyed on the exists-condition
 * path being an ancestor of `subagentParentPath`, never on a rule's editable
 * `reason`. Returns the original object unchanged when there is nothing to
 * mask, with `maskedAny: false` (unknown agent, no declared parent path, or
 * no matching drop rule) — the caller uses that flag to detect a
 * reattribution request that can't actually neutralize the live drop rule.
 */
function maskSubagentDropMeta(
  agent: string,
  meta: Record<string, unknown> | undefined,
): { meta: Record<string, unknown> | undefined; maskedAny: boolean } {
  if (!meta) return { meta, maskedAny: false };
  const entry = HOOK_CONFIG[agent];
  const parentPath = entry?.subagentParentPath;
  const rules = entry?.captureRules;
  if (!parentPath || !rules) return { meta, maskedAny: false };
  const maskPaths = rules
    .filter((r) => r.event === 'user_prompt' && r.action === 'drop')
    .map((r) => r.when.transcript_meta_field_exists)
    .filter((p): p is string => !!p && (p === parentPath || parentPath.startsWith(`${p}.`)));
  if (maskPaths.length === 0) return { meta, maskedAny: false };
  const clone = structuredClone(meta);
  for (const p of maskPaths) unsetAtPath(clone, p);
  return { meta: clone, maskedAny: true };
}
