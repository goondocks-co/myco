/**
 * What a session is served: the plan-intent nudge and the session's unseen
 * spores at prompt-submit time, and the Project's instructions and preferred
 * digest when a session or a subagent starts — each composed into one block for
 * the member hook that asked for it.
 *
 * This module OWNS `session_injections`. One row per (project, session, kind)
 * carries a contributor a session receives at most once; the `INSERT OR IGNORE`
 * and the `meta.changes` it answers from are the pattern `core/injection.ts`
 * already proves on both targets — the store decides, and the caller reads the
 * decision off the write.
 *
 * The row holds NO foreign key to `sessions`: the prompt hook answers before
 * the session's own event lands on the server, so a record may precede the
 * session it names, and a key would refuse the common case.
 *
 * A record is at-most-once. An answer lost on the wire has burned the record
 * with nothing delivered, which is the trade the primary key buys: a nudge
 * repeated on every prompt of a session is worse than a nudge missed once.
 *
 * The gates run in a fixed order and the capability is total: a Project not
 * admitted to `cortex` is served an empty block with `capability` named, and no
 * contributor runs at all. Each contributor after it runs in its own try and
 * names in `skipped` the gate it closed on, or itself when it throws, so one
 * failing contributor costs its own part rather than the whole answer and an
 * empty block always says which gate produced it.
 *
 * The nudge stands FIRST in the text: it is one sentence a person is meant to
 * act on, and a reader who meets it under a block of observations meets it
 * last. The spore block, which is read rather than acted on, follows.
 *
 * The nudge is recorded LAST, after the spore selection has committed: a
 * failure in the spore half then leaves the nudge unburned for the next prompt.
 */
import type { RelationalStore } from './adapters.js';
import { digestForTier, listDigests } from './digests.js';
import { INJECTION_LEAVES, injectionLeaves, selectSporesForPrompt, type InjectionLeaves, type InjectionSkip } from './injection.js';
import type { SemanticSearch } from '../read/embedding.js';
import { leafValues } from './settings.js';
import { sha256Hex } from '../hash.js';
import { newestInstructions } from '../read/cortex.js';
import type { ReadScope } from '../read/scope.js';
import { sessionInjectionKind, type SessionContextRequest, type SessionContextIdentity } from '@goondocks/myco-shared/recall';
export { sessionInjectionKind } from '@goondocks/myco-shared/recall';

/** The most text one prompt is served. A part that would cross it is dropped whole. */
export const PROMPT_CONTEXT_MAX_CHARS = 10_000;

/**
 * The most text one session start is served: room for a 10 000-token digest
 * standing beside the Project's instructions. A part that would cross it is
 * dropped whole.
 */
export const SESSION_CONTEXT_MAX_CHARS = 60_000;

/** The blank line between two parts of one served block. */
const JOIN = '\n\n';

/**
 * Planning intent, as a fixed word-bounded keyword set rather than a model
 * call. A detector that needs tuning is a maintenance treadmill, and this one
 * gates a single sentence.
 */
const PLAN_INTENT_PATTERN =
  /\b(plan|plans|planning|spec|specs|roadmap|milestone|milestones|phase|phases|design doc|implementation plan)\b/i;

export function detectsPlanIntent(prompt: string): boolean {
  return PLAN_INTENT_PATTERN.test(prompt);
}

/** The one sentence a session is served when its prompt carries planning intent. */
export const PLAN_INTENT_NUDGE =
  'Myco is where plans live — persist and update them with `myco_plans` (op: "save", with `status` transitions), and pick up an existing plan in a new session by its ID with op: "get".';

/** The leaf default, applied where the Deployment has written none. */
export const PLAN_NUDGE_DEFAULT = true;
const PLAN_NUDGE_LEAF = 'cortex.plans.inject_intent_nudge_on_prompt_submit';

const INSTRUCTIONS_START_LEAF = 'cortex.instructions.inject_on_session_start';
const INSTRUCTIONS_SUBAGENT_LEAF = 'cortex.instructions.inject_on_subagent_start';
const DIGEST_START_LEAF = 'cortex.digest.inject_on_session_start';
const DIGEST_TIER_LEAF = 'cortex.digest.tier';

/** Instructions travel to a starting session and to a starting subagent unless the Deployment says not to. */
export const INSTRUCTIONS_START_DEFAULT = true;
export const INSTRUCTIONS_SUBAGENT_DEFAULT = true;
/** The digest is the expensive half of a session start, and it is served only where a Deployment asks for it. */
export const DIGEST_START_DEFAULT = false;
/** The digest sizes the Settings page offers, and the one it starts on. */
export const DIGEST_TIERS: readonly number[] = [1500, 5000, 10000];
export const DIGEST_TIER_DEFAULT = 5000;

/** The leaves recall reads. */
export const RECALL_LEAVES: readonly string[] = [
  ...INJECTION_LEAVES, PLAN_NUDGE_LEAF,
  INSTRUCTIONS_START_LEAF, INSTRUCTIONS_SUBAGENT_LEAF, DIGEST_START_LEAF, DIGEST_TIER_LEAF,
];

export interface RecallLeaves {
  injection: InjectionLeaves;
  planNudge: boolean;
  instructionsAtSessionStart: boolean;
  instructionsAtSubagentStart: boolean;
  digestAtSessionStart: boolean;
  /** One of `DIGEST_TIERS`; a stored value naming any other size falls to the default. */
  digestTier: number;
}

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

/** Recall's leaves over the stored values, each defaulted. */
export function recallLeaves(leaves: Record<string, unknown>): RecallLeaves {
  const tier = leaves[DIGEST_TIER_LEAF];
  return {
    injection: injectionLeaves(leaves),
    planNudge: bool(leaves[PLAN_NUDGE_LEAF], PLAN_NUDGE_DEFAULT),
    instructionsAtSessionStart: bool(leaves[INSTRUCTIONS_START_LEAF], INSTRUCTIONS_START_DEFAULT),
    instructionsAtSubagentStart: bool(leaves[INSTRUCTIONS_SUBAGENT_LEAF], INSTRUCTIONS_SUBAGENT_DEFAULT),
    digestAtSessionStart: bool(leaves[DIGEST_START_LEAF], DIGEST_START_DEFAULT),
    digestTier: typeof tier === 'number' && DIGEST_TIERS.includes(tier) ? tier : DIGEST_TIER_DEFAULT,
  };
}

const parse = (value: string | undefined): unknown => {
  if (value === undefined) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
};

/** The Deployment's stored recall leaves, defaulted. */
export async function readRecallLeaves(db: RelationalStore): Promise<RecallLeaves> {
  const byLeaf = await leafValues(db, RECALL_LEAVES);
  return recallLeaves(Object.fromEntries(RECALL_LEAVES.map((leaf) => [leaf, parse(byLeaf.get(leaf))])));
}

/**
 * Records that this session has been served `kind`, and answers whether the
 * record is new. A second call for the same (project, session, kind) answers
 * false, and the caller serves nothing.
 */
export async function recordSessionInjection(
  db: RelationalStore,
  scope: ReadScope,
  sessionId: string,
  kind: string,
  now: number,
): Promise<boolean> {
  const written = await db
    .prepare(`INSERT OR IGNORE INTO session_injections (project_id, session_id, kind, created_at) VALUES (?, ?, ?, ?)`)
    .bind(scope.projectId, sessionId, kind, now)
    .run();
  return written.meta.changes === 1;
}

/** What one part of a served block is, named so a reader knows what it carries. */
export type PromptContextPart =
  | { kind: 'plan-nudge' }
  | { kind: 'spores'; sporeIds: string[] };

/** What one part of a session's served block is; a digest names the tier it actually carries. */
export type SessionContextPart =
  | { kind: 'instructions' }
  | { kind: 'digest'; tier: number };

/** Why the nudge stood down when nothing went wrong. */
export type NudgeSkip = 'off' | 'no_intent' | 'repeat';

/** Why the instructions or the digest stood down when nothing went wrong. */
export type CortexSkip = 'off' | 'empty';

/**
 * Why a contributor served nothing, and why a whole block did.
 *
 * A bare contributor name is a throw inside it. A qualified name is the gate it
 * closed on: the selector's own gates travel under `spores:`, the nudge's under
 * `plan-nudge:`, and the two session contributors under `instructions:` and
 * `digest:`. `capability` and `repeat` answer for the whole block — a Project
 * not admitted, and a session already holding the record this block would burn.
 * A caller reading an empty block therefore learns which gate closed rather
 * than only that one did.
 */
export type RecallSkip =
  | 'capability'
  | 'repeat'
  | 'spores'
  | 'plan-nudge'
  | 'instructions'
  | 'digest'
  | `spores:${InjectionSkip}`
  | `plan-nudge:${NudgeSkip}`
  | `instructions:${CortexSkip}`
  | `digest:${CortexSkip}`;

export interface PromptContext {
  context: string;
  parts: PromptContextPart[];
  skipped: RecallSkip[];
}

export interface RecallSessionBlock {
  context: string;
  parts: SessionContextPart[];
  skipped: RecallSkip[];
  /**
   * The record this block burns, or would have burned. Answered whatever the
   * outcome, so the member remembers a settled decision under the same name the
   * Deployment keeps it under.
   */
  kind: string;
}

/** One contributor's part and the text it puts into the served block. */
export interface Contribution<Part = PromptContextPart> {
  part: Part;
  text: string;
}

/**
 * The contributions that fit under the bound, in order.
 *
 * A contribution that would cross the bound is dropped whole, along with
 * everything after it, so a served block ends at a part boundary rather than
 * mid-line.
 *
 * A dropped part is already recorded by the contributor that built it, and the
 * session is not served it again: the records are at-most-once, and a part lost
 * to the bound costs what a lost answer costs.
 */
export function partsWithinBound<Part>(
  contributions: readonly Contribution<Part>[],
  max: number = PROMPT_CONTEXT_MAX_CHARS,
): Contribution<Part>[] {
  const kept: Contribution<Part>[] = [];
  let length = 0;
  for (const contribution of contributions) {
    const grown = length === 0 ? contribution.text.length : length + JOIN.length + contribution.text.length;
    if (grown > max) break;
    kept.push(contribution);
    length = grown;
  }
  return kept;
}

/**
 * The block one prompt is served, and the records of having served it.
 *
 * The prompt is named to the spore selector by `sha256` of the text the member
 * sent, not by the prompt event's own content hash: a prompt long enough to
 * spill carries its blob key as that hash, so one text inline and the same text
 * spilled read as two different contents and each serves the session again.
 */
export async function composePromptContext(
  db: RelationalStore,
  scope: ReadScope,
  leaves: RecallLeaves,
  capabilityOn: boolean,
  input: { sessionId: string; promptId: string; text: string; now: number },
  resolveSemantic?: () => Promise<SemanticSearch | null>,
): Promise<PromptContext> {
  if (!capabilityOn) return { context: '', parts: [], skipped: ['capability'] };

  const skipped: RecallSkip[] = [];

  let spores: Contribution | null = null;
  try {
    const selection = await selectSporesForPrompt(db, scope, leaves.injection, capabilityOn, {
      sessionId: input.sessionId,
      promptId: input.promptId,
      promptHash: await sha256Hex(input.text),
      prompt: input.text,
      now: input.now,
    }, resolveSemantic);
    if (selection.skipped !== null) skipped.push(`spores:${selection.skipped}`);
    else if (selection.context.length > 0) {
      spores = { part: { kind: 'spores', sporeIds: selection.spores.map((s) => s.id) }, text: selection.context };
    }
  } catch {
    skipped.push('spores');
  }

  let nudge: Contribution | null = null;
  try {
    if (!leaves.planNudge) skipped.push('plan-nudge:off');
    else if (!detectsPlanIntent(input.text)) skipped.push('plan-nudge:no_intent');
    else if (!(await recordSessionInjection(db, scope, input.sessionId, 'plan-nudge', input.now))) skipped.push('plan-nudge:repeat');
    else nudge = { part: { kind: 'plan-nudge' }, text: PLAN_INTENT_NUDGE };
  } catch {
    skipped.push('plan-nudge');
  }

  const kept = partsWithinBound([nudge, spores].filter((c): c is Contribution => c !== null));

  return {
    context: kept.map((c) => c.text).join(JOIN),
    parts: kept.map((c) => c.part),
    skipped,
  };
}

/**
 * The three lines a delegated subagent is handed above the Project's
 * instructions, telling it what the text below is and how far its own authority
 * runs. Carried verbatim from the member-side surface they were written for.
 */
export const SUBAGENT_CORTEX_GUIDANCE = [
  'You are a delegated subagent working inside a Myco-connected project.',
  'Follow these managed Cortex instructions as current project guidance.',
  'Apply them to your assigned task, and defer broad orchestration decisions back to the parent agent.',
].join('\n');

/** The heading a digest stands under, naming the tier the block actually carries. */
export const digestHeading = (tier: number): string => `## Preferred Digest (Tier ${tier})\n`;

/** The session lifecycle event requesting context. */
export type SessionContextKind = SessionContextIdentity['kind'];

/**
 * The block served at session start, after compaction, or at subagent start.
 *
 * Instructions stand first with no heading of their own — the artifact is
 * written to be read as project guidance, and a frame around it would be one
 * more thing to keep true. A subagent gets the guidance lines above them and
 * never the digest: a delegated task inherits its parent's framing rather than
 * re-reading the whole project.
 *
 * The record is written AFTER the block composes and only where there is
 * something to serve, so a Project holding no instructions and no digest leaves
 * the session unburned. A second start for the same session composes the same
 * block, finds the record standing, and serves an empty block naming `repeat`.
 */
export async function composeSessionContext(
  db: RelationalStore,
  scope: ReadScope,
  leaves: RecallLeaves,
  capabilityOn: boolean,
  input: SessionContextRequest & { now: number },
): Promise<RecallSessionBlock> {
  const recordKind = sessionInjectionKind(input);
  if (!capabilityOn) return { context: '', parts: [], skipped: ['capability'], kind: recordKind };

  const skipped: RecallSkip[] = [];
  const contributions: Contribution<SessionContextPart>[] = [];

  const wantsInstructions = input.kind !== 'subagent'
    ? leaves.instructionsAtSessionStart
    : leaves.instructionsAtSubagentStart;
  try {
    if (!wantsInstructions) skipped.push('instructions:off');
    else {
      const trimmed = (await newestInstructions(db, scope))?.content.trim() ?? '';
      if (trimmed.length === 0) skipped.push('instructions:empty');
      else {
        contributions.push({
          part: { kind: 'instructions' },
          text: input.kind === 'subagent' ? `${SUBAGENT_CORTEX_GUIDANCE}${JOIN}${trimmed}` : trimmed,
        });
      }
    }
  } catch {
    skipped.push('instructions');
  }

  // A parent session receives the digest at initial start and after compaction.
  if (input.kind !== 'subagent') {
    try {
      if (!leaves.digestAtSessionStart) skipped.push('digest:off');
      else {
        const served = digestForTier(await listDigests(db, scope), leaves.digestTier);
        if (served === null) skipped.push('digest:empty');
        else {
          contributions.push({
            part: { kind: 'digest', tier: served.row.tier },
            text: `${digestHeading(served.row.tier)}${served.row.content}`,
          });
        }
      }
    } catch {
      skipped.push('digest');
    }
  }

  const kept = partsWithinBound(contributions, SESSION_CONTEXT_MAX_CHARS);
  if (kept.length === 0) return { context: '', parts: [], skipped, kind: recordKind };

  if (!await recordSessionInjection(db, scope, input.sessionId, recordKind, input.now)) {
    return { context: '', parts: [], skipped: [...skipped, 'repeat'], kind: recordKind };
  }
  return {
    context: kept.map((c) => c.text).join(JOIN),
    parts: kept.map((c) => c.part),
    skipped,
    kind: recordKind,
  };
}
