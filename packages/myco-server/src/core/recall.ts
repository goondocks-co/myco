import {pruneSelectedPromptAnswers,type ExpiredPromptAnswer} from './prompt-answer-retention.js';
import {preparePromptAnswer,prepareSessionRecord,prepareContextDelivery,commitContextWrite,type ContextCommit} from './context-writes.js';
/**
 * What a session is served: the plan-intent nudge and the session's ranked
 * items at prompt-submit time, and the Project id and the Deployment's
 * instructions when a session or a subagent starts — each composed into one
 * block for the member hook that asked for it.
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
import type { ErrorClassifier, RelationalStore } from './adapters.js';
import type { ContextTimings } from './context-timing.js';
import { INJECTION_LEAVES, InjectionFailure, emptyInjectionCounts, injectionLeaves, selectSporesForPrompt, type AskNaming, type Delivery, type InjectionCounts, type InjectionLeaves, type InjectionSkip } from './injection.js';
import type { PreparedStatement } from './adapters.js';
import type { SemanticSearch } from '../read/embedding.js';
import { INSTRUCTIONS_TEMPLATE_LEAF, settingTexts } from './settings.js';
import { sha256Hex } from '../hash.js';
import type { ReadScope } from '../read/scope.js';
import type { SessionWriteAdmission } from '../ingest/projections.js';
import type { Refusal } from '../telemetry.js';
import { classify, emit, type ErrorClass } from '../telemetry.js';
import { BLOCK_JOIN, projectLine, sessionInjectionKind, type SessionContextRequest, type SessionContextIdentity } from '@goondocks/myco-shared/recall';
import { promptKeyHash, type DeliveredSessionRecord } from '@goondocks/myco-shared/prompt-identity';
export { sessionInjectionKind } from '@goondocks/myco-shared/recall';

/** The most text one prompt is served. A part that would cross it is dropped whole. */
export const PROMPT_CONTEXT_MAX_CHARS = 10_000;
export const PROMPT_ANSWER_RETENTION_DAYS = 30;

/**
 * The most text one session start is served: the Project line beside a
 * template at its own 4 KB ceiling, with room for the subagent preamble. A
 * part that would cross it is dropped whole.
 */
export const SESSION_CONTEXT_MAX_CHARS = 8_192;

/** The blank line between two parts of one served block. */
const JOIN = BLOCK_JOIN;

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

/** Instructions travel to a starting session and to a starting subagent unless the Deployment says not to. */
export const INSTRUCTIONS_START_DEFAULT = true;
export const INSTRUCTIONS_SUBAGENT_DEFAULT = true;
/** The leaves recall reads. */
export const RECALL_LEAVES: readonly string[] = [
  ...INJECTION_LEAVES, PLAN_NUDGE_LEAF,
  INSTRUCTIONS_START_LEAF, INSTRUCTIONS_SUBAGENT_LEAF, INSTRUCTIONS_TEMPLATE_LEAF,
];

export interface RecallLeaves {
  injection: InjectionLeaves;
  planNudge: boolean;
  instructionsAtSessionStart: boolean;
  instructionsAtSubagentStart: boolean;
  /** The Deployment's session-start text, empty where none is written. */
  instructionsTemplate: string;
}

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

/** Recall's leaves over the stored values, each defaulted. */
export function recallLeaves(leaves: Record<string, unknown>): RecallLeaves {
  const template = leaves[INSTRUCTIONS_TEMPLATE_LEAF];
  return {
    injection: injectionLeaves(leaves),
    planNudge: bool(leaves[PLAN_NUDGE_LEAF], PLAN_NUDGE_DEFAULT),
    instructionsAtSessionStart: bool(leaves[INSTRUCTIONS_START_LEAF], INSTRUCTIONS_START_DEFAULT),
    instructionsAtSubagentStart: bool(leaves[INSTRUCTIONS_SUBAGENT_LEAF], INSTRUCTIONS_SUBAGENT_DEFAULT),
    instructionsTemplate: typeof template === 'string' ? template : '',
  };
}

const parse = (value: string | undefined): unknown => {
  if (value === undefined) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
};

/** The Deployment's stored recall leaves, defaulted. */
export async function readRecallLeaves(db: RelationalStore): Promise<RecallLeaves> {
  const byLeaf = await settingTexts(db, RECALL_LEAVES);
  return recallLeaves(Object.fromEntries(RECALL_LEAVES.map((leaf) => [leaf, parse(byLeaf.get(leaf))])));
}

/**
 * The outcome of recording that a session is served `kind`: a new record, a `repeat` of one the session already holds
 * (the caller serves nothing), or the session's admission refusing the write (the caller answers the refusal).
 */
export type SessionRecordWrite = { outcome: 'recorded' } | { outcome: 'repeat' } | { outcome: 'refused'; refusal: Refusal };

/** Records that this session has been served `kind`, once per (project, session, kind). */
export async function recordSessionInjection(
  db: RelationalStore,
  scope: ReadScope,
  sessionId: string,
  kind: string,
  now: number,
  admission: SessionWriteAdmission,
  commit:ContextCommit=commitContextWrite,
): Promise<SessionRecordWrite> {
  const [written]=await commit(db,prepareSessionRecord(db,scope.projectId,sessionId,kind,now,admission.admission));
  if (written!.meta.changes === 1) return { outcome: 'recorded' };
  const refusal = await admission.refusal(db);
  return refusal === null ? { outcome: 'repeat' } : { outcome: 'refused', refusal };
}

/** What one part of a served block is, named so a reader knows what it carries. */
export type PromptContextPart =
  | { kind: 'plan-nudge' }
  | { kind: 'spores'; sporeIds: string[]; planIds: string[] };

/** What one part of a session's served block is. */
export type SessionContextPart =
  | { kind: 'project' }
  | { kind: 'instructions' };

/** Why the nudge stood down when nothing went wrong. */
export type NudgeSkip = 'off' | 'no_intent' | 'repeat' | 'unwritable';

/** Why the instructions stood down when nothing went wrong. */
export type CortexSkip = 'off' | 'empty';

/**
 * Why a contributor served nothing, and why a whole block did.
 *
 * A bare contributor name is a throw inside it. A qualified name is the gate it
 * closed on: the selector's own gates travel under `spores:`, the nudge's under
 * `plan-nudge:`, and the session contributor under `instructions:`.
 * `capability` and `repeat` answer for the whole block — a Project
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
  | `spores:${InjectionSkip}`
  | `plan-nudge:${NudgeSkip}`
  | `instructions:${CortexSkip}`;

export interface PromptContext {
  context: string;
  parts: PromptContextPart[];
  skipped: RecallSkip[];
  /** The receipt and the answer rows this ask wrote, each named only when its write succeeded: what a delivery names. */
  receiptId?: string;
  answerId?: string;
  /** The session record the served block carried (the plan nudge), by its key: what a delivery names so it outlives this answer. */
  sessionRecord?: DeliveredSessionRecord;
  /** Why the session's admission held the answer back: nothing is recorded for it, and nothing is served. */
  refusal?: Refusal;
}

/** A failed contributor's coded cause; no prompt body or arbitrary error text is retained. */
export interface RecallFailure {
  contributor: 'spores' | 'plan-nudge' | 'instructions';
  error: ErrorClass;
  operation?: InjectionFailure['operation'];
}

/** Isolates a contributor and records its failure before the remaining contributors run. */
async function contribute<T>(
  identity: { projectId: string; sessionId: string; promptId?: string | null },
  contributor: RecallFailure['contributor'],
  skipped: RecallSkip[],
  failures: RecallFailure[],
  work: () => Promise<T>,
  classifyError?: ErrorClassifier,
): Promise<T | null> {
  try { return await work(); }
  catch (error) {
    const failure: RecallFailure = {
      contributor, error: classify(error instanceof InjectionFailure ? error.cause : error, classifyError),
      ...(error instanceof InjectionFailure ? { operation: error.operation } : {}),
    };
    skipped.push(contributor);
    failures.push(failure);
    emit({ kind: 'recall_contributor_failed', ...identity, ...failure });
    return null;
  }
}

/**
 * Appends the answer under the prompt that asked, before capture has necessarily recorded that prompt, and names the
 * row it wrote: an answer whose write failed names none, and one the session's admission held back serves nothing.
 */
async function recordPromptAnswer(
  db: RelationalStore,
  identity: { projectId: string; sessionId: string; promptId: string | null },
  naming: AskNaming,
  admission: SessionWriteAdmission,
  answer: PromptContext,
  failures: readonly RecallFailure[],
  selection: InjectionCounts,
  now: number,
  classifyError?: ErrorClassifier,
  commit:ContextCommit=commitContextWrite,
): Promise<PromptContext> {
  const answerId = crypto.randomUUID();
  let unrecorded: ErrorClass;
  try {
    const [written]=await commit(db,preparePromptAnswer(db,{project:identity.projectId,session:identity.sessionId,id:answerId,promptId:naming.promptId,
      scopeReason:naming.scopeReason,protocol:naming.askProtocol,askedAt:naming.askedAt,receiptId:answer.receiptId??null,
      outcome:answer.context.length>0?'served':'empty',chars:answer.context.length,
      parts:answer.parts.map(part=>part.kind==='spores'?{kind:part.kind,sporeCount:part.sporeIds.length,planCount:part.planIds.length}:part),
      skipped:answer.skipped,failures,selection,now},admission.admission));
    if (written!.meta.changes === 1) return { ...answer, answerId };
    const refusal = await admission.refusal(db);
    if (refusal !== null) return { context: '', parts: [], skipped: answer.skipped, refusal };
    unrecorded = 'unknown';
  } catch (error) {
    unrecorded = classify(error, classifyError);
  }
  emit({ kind: 'recall_answer_unrecorded', ...identity, error: unrecorded });
  return answer;
}

/** Mark one answer delivered, once: the same rule a receipt's delivery follows (`receiptDeliveredStatement`). */
export function answerDeliveredStatement(db: RelationalStore, d: Delivery, gate: { sql: string; params: unknown[] }): PreparedStatement {
  return prepareContextDelivery(db,'answer',d,gate).statement;
}

/**
 * Mark a session's record delivered by its key, once: the record outlives the answer that carried it, so a delivery
 * reported after that answer is pruned still lands.
 */
export function sessionRecordDeliveredStatement(db: RelationalStore, d: Omit<Delivery, 'id'> & { record: DeliveredSessionRecord }, gate: { sql: string; params: unknown[] }): PreparedStatement {
  return prepareContextDelivery(db,'session-record',{...d,id:d.record},gate).statement;
}

/**
 * Mark the session's plan nudge delivered through the answer that carried it, once: how a delivery from a member that
 * names only the answer reaches the nudge's record, while that answer is held.
 */
export function planNudgeDeliveredStatement(db: RelationalStore, d: Delivery, gate: { sql: string; params: unknown[] }): PreparedStatement {
  return prepareContextDelivery(db,'session-record',{...d,id:'plan-nudge'},gate,d.id).statement;
}

export const PROMPT_ANSWER_RETENTION_SQL = `SELECT a.project_id,a.session_id,a.id
  FROM projects p CROSS JOIN prompt_context_answers a
  WHERE a.project_id=p.project_id AND a.created_at<? LIMIT ?`;

/** Deletes at most one batch of prompt answer diagnostics older than the cutoff across the Deployment's Projects. */
export async function prunePromptAnswers(db: RelationalStore, cutoffMs: number, limit: number): Promise<number> {
  const targets = (
    await db
      .prepare(PROMPT_ANSWER_RETENTION_SQL)
      .bind(cutoffMs, limit)
      .all<ExpiredPromptAnswer>()
  ).results;
  return pruneSelectedPromptAnswers(db, targets, cutoffMs);
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
  /** Why the session's admission held the block's record back: nothing is recorded, and nothing is served. */
  refusal?: Refusal;
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
  input: { sessionId: string; text: string; now: number; admission: SessionWriteAdmission } & Partial<AskNaming>,
  resolveSemantic?: () => Promise<SemanticSearch | null>,
  classifyError?: ErrorClassifier,
  timings?: ContextTimings,
  commit:ContextCommit=commitContextWrite,
): Promise<PromptContext> {
  const naming: AskNaming = { promptId: input.promptId ?? null, scopeReason: input.scopeReason ?? null, askProtocol: input.askProtocol ?? 'legacy', askedAt: input.askedAt ?? null };
  const identity = { projectId: scope.projectId, sessionId: input.sessionId, promptId: naming.promptId };
  let counts = emptyInjectionCounts();
  let receiptId: string | undefined;
  if (!capabilityOn) return recordPromptAnswer(db, identity, naming, input.admission, { context: '', parts: [], skipped: ['capability'] }, [], counts, input.now, classifyError,commit);

  const skipped: RecallSkip[] = [];
  const failures: RecallFailure[] = [];

  const spores = await contribute<Contribution | null>(identity, 'spores', skipped, failures, async () => {
    const selection = await selectSporesForPrompt(db, scope, leaves.injection, capabilityOn, {
      sessionId: input.sessionId,
      ...naming,
      promptHash: await promptKeyHash(sha256Hex, input.text),
      prompt: input.text,
      now: input.now,
      admission: input.admission,
    }, resolveSemantic, timings,commit).catch((error: unknown) => {
      if (error instanceof InjectionFailure) counts = error.counts;
      throw error;
    });
    counts = selection.counts;
    receiptId = selection.receiptId;
    if (selection.skipped !== null) skipped.push(`spores:${selection.skipped}`);
    else if (selection.context.length > 0) {
      return { part: { kind: 'spores', sporeIds: selection.items.filter((i) => i.kind === 'spore').map((i) => i.id), planIds: selection.items.filter((i) => i.kind === 'plan').map((i) => i.id) }, text: selection.context };
    }
    return null;
  }, classifyError);

  const nudge = await contribute<Contribution | null>(identity, 'plan-nudge', skipped, failures, async () => {
    if (!leaves.planNudge) skipped.push('plan-nudge:off');
    else if (!detectsPlanIntent(input.text)) skipped.push('plan-nudge:no_intent');
    else {
      const nudge = await recordSessionInjection(db, scope, input.sessionId, 'plan-nudge', input.now, input.admission,commit);
      if (nudge.outcome === 'recorded') return { part: { kind: 'plan-nudge' }, text: PLAN_INTENT_NUDGE };
      skipped.push(nudge.outcome === 'repeat' ? 'plan-nudge:repeat' : 'plan-nudge:unwritable');
    }
    return null;
  }, classifyError);

  const kept = partsWithinBound([nudge, spores].filter((c): c is Contribution => c !== null));

  return recordPromptAnswer(db, identity, naming, input.admission, {
    context: kept.map((c) => c.text).join(JOIN),
    parts: kept.map((c) => c.part),
    skipped,
    // A receipt whose part the bound dropped never reaches the agent, so no delivery may name it; so too the nudge's record.
    ...(receiptId === undefined || !kept.some((c) => c.part.kind === 'spores') ? {} : { receiptId }),
    ...(kept.some((c) => c.part.kind === 'plan-nudge') ? { sessionRecord: 'plan-nudge' as const } : {}),
  }, failures, counts, input.now, classifyError,commit);
}

/**
 * The three lines a delegated subagent is handed above the Project's
 * instructions, telling it what the text below is and how far its own authority
 * runs. Carried verbatim from the member-side surface they were written for.
 */
/** The Project line every session block starts with: one copy, shared with the member that renders it from its cache. */
export { projectLine };

export const SUBAGENT_CORTEX_GUIDANCE = [
  'You are a delegated subagent working inside a Myco-connected project.',
  'Follow these managed Cortex instructions as current project guidance.',
  'Apply them to your assigned task, and defer broad orchestration decisions back to the parent agent.',
].join('\n');

/** The session lifecycle event requesting context. */
export type SessionContextKind = SessionContextIdentity['kind'];

/**
 * The block served at session start, after compaction, or at subagent start.
 *
 * The Project line stands first and is served unconditionally — before the
 * Deployment's own text, and before the capability gate that holds the rest
 * back. It is the value a write is refused without, so a Project the Deployment
 * has not admitted to `cortex` still learns the id its writes must name.
 * Instructions follow it with no heading of their own, written to be read as
 * project guidance. A subagent gets the guidance lines above them.
 *
 * The Project line is always something to serve, so every session start burns
 * its record and a second start answers `repeat`. The session that started
 * before a Deployment wrote its template is therefore not served it later; the
 * next session is. That is the cost of telling every session its Project id,
 * and it is the right way round: an id every write needs is worth more than a
 * mid-session pickup of text an owner has only just written.
 */
export async function composeSessionContext(
  db: RelationalStore,
  scope: ReadScope,
  leaves: RecallLeaves,
  capabilityOn: boolean,
  input: SessionContextRequest & { now: number },
  /**
   * `preview`: compose the block and record nothing, so no session is held to have been served it. What a member
   * asks for when it joins a project, to have the block cached before its first session starts. A block that is
   * recorded carries the session's write admission.
   */
  opts: ({ preview: true } | { preview?: false; admission: SessionWriteAdmission }) & { classifyError?: ErrorClassifier },
  commit:ContextCommit=commitContextWrite,
): Promise<RecallSessionBlock> {
  const recordKind = sessionInjectionKind(input);
  const skipped: RecallSkip[] = [];
  const contributions: Contribution<SessionContextPart>[] = [];

  contributions.push({ part: { kind: 'project' }, text: projectLine(scope.projectId) });

  // The capability is the whole gate on what the Deployment stores and serves,
  // so it is named alone: a block that also named the instructions switch would
  // report a gate the caller could open to no effect.
  const wantsInstructions = input.kind !== 'subagent'
    ? leaves.instructionsAtSessionStart
    : leaves.instructionsAtSubagentStart;
  await contribute({ projectId: scope.projectId, sessionId: input.sessionId }, 'instructions', skipped, [], async () => {
    if (!capabilityOn) skipped.push('capability');
    else if (!wantsInstructions) skipped.push('instructions:off');
    else {
      const trimmed = leaves.instructionsTemplate.trim();
      if (trimmed.length === 0) skipped.push('instructions:empty');
      else {
        contributions.push({
          part: { kind: 'instructions' },
          text: input.kind === 'subagent' ? `${SUBAGENT_CORTEX_GUIDANCE}${JOIN}${trimmed}` : trimmed,
        });
      }
    }
  }, opts.classifyError);

  const kept = partsWithinBound(contributions, SESSION_CONTEXT_MAX_CHARS);
  if (kept.length === 0) return { context: '', parts: [], skipped, kind: recordKind };

  if (opts.preview !== true) {
    const record = await recordSessionInjection(db, scope, input.sessionId, recordKind, input.now, opts.admission,commit);
    if (record.outcome === 'refused') return { context: '', parts: [], skipped, kind: recordKind, refusal: record.refusal };
    if (record.outcome === 'repeat') return { context: '', parts: [], skipped: [...skipped, 'repeat'], kind: recordKind };
  }
  return {
    context: kept.map((c) => c.text).join(JOIN),
    parts: kept.map((c) => c.part),
    skipped,
    kind: recordKind,
  };
}
