/**
 * `myco_run_learning`: session learning's own material and completion.
 *
 * It takes no session argument. The session and the slice are the ones the claim wrote into the run's context, so a
 * run reads and completes exactly its assignment: it reads its slice's cards, may open the raw turn behind a
 * high-signal card from the turn's pages, and completes the slice.
 */
import { failure, runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';
import { recordServedPrompts } from '../../core/served-material.js';
import { RAW_TURN_CHARS } from '../../core/read-window.js';
import type { TurnInput } from '../../core/turn-card-rules.js';
import { documentTurnInput } from '../../content/turn-material.js';
import { assignedCards, completeLearning, HANDOFF_MAX_BYTES, type LearningAssignment } from '../../core/learning-sessions.js';
import { LEARNING_TOOL } from '../../core/tool-catalogue.js';

export function assignmentOf<T extends { kind: string }>(runContext: string | null, kind: T['kind']): { sessionId: string; assignment: T } | null {
  try {
    const context = JSON.parse(runContext ?? 'null') as { session_id?: unknown; assignment?: T } | null;
    return typeof context?.session_id === 'string' && context.assignment?.kind === kind ? { sessionId: context.session_id, assignment: context.assignment } : null;
  } catch { return null; }
}

function rawTurnText(turn: TurnInput): string {
  const lines = [`PROMPT (${turn.origin}):`, turn.prompt, ...turn.steering.flatMap((s) => ['STEERING PROMPT:', s.text])];
  for (const reply of turn.replies) lines.push('REPLY:', reply.text);
  for (const tool of turn.tools) {
    lines.push(`TOOL ${tool.toolName} ${tool.input ?? ''}${tool.success ? '' : ' [FAILED]'}`);
    if (tool.errorMessage !== null) lines.push(`error: ${tool.errorMessage}`);
    if (tool.output !== null) lines.push(`result:\n${tool.output}`);
  }
  for (const plan of turn.plans) lines.push(`PLAN ${plan.title ?? plan.planKey} (${plan.status})`, plan.content ?? '');
  const text = lines.join('\n');
  return text.length <= RAW_TURN_CHARS ? text : `${text.slice(0, RAW_TURN_CHARS)}\n[… ${text.length - RAW_TURN_CHARS} more characters]`;
}

export async function handleRunLearning(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const run = runOf(ctx, LEARNING_TOOL);
  const held = assignmentOf<LearningAssignment>(run.runContext, 'learning');
  if (held === null) return failure('this run carries no learning assignment');
  const { db } = ctx.env;
  const scope = { projectId: ctx.projectId };
  const cards = await assignedCards(db, ctx.projectId, held.sessionId, held.assignment);
  if (input.op === 'material') {
    await recordServedPrompts(db, scope, run.runId,
      cards.flatMap((card) => card.promptIds.map((promptId) => ({ promptId, sessionId: held.sessionId, createdAt: 0, endedAt: null }))), ctx.now);
    return {
      session_id: held.sessionId, handoff: held.assignment.handoff, more_slices: held.assignment.more,
      cards: cards.map((card) => ({ turn_key: card.turnKey, signal: card.signal, card: card.card })),
      ...(cards.length < held.assignment.turns.length ? { changed_since_assignment: held.assignment.turns.length - cards.length } : {}),
    };
  }
  if (input.op === 'get') {
    const card = cards.find((c) => c.turnKey === input.turn_key);
    if (card === undefined) return failure('turn_key names no card of this slice');
    if (card.signal !== 'high') return failure('only a high-signal card opens its raw turn');
    const turn = await documentTurnInput(ctx.env, ctx.projectId, held.sessionId, card.turnKey);
    return turn === null ? failure('the turn is no longer held') : { turn_key: card.turnKey, raw: rawTurnText(turn) };
  }
  if (input.op === 'complete') {
    const handoff = typeof input.handoff === 'string' ? input.handoff : '';
    if (new TextEncoder().encode(handoff).length > HANDOFF_MAX_BYTES) return failure(`handoff runs past ${HANDOFF_MAX_BYTES} bytes`);
    const result = await completeLearning(db, ctx.projectId, held.sessionId, run.runId, held.assignment, handoff, ctx.now);
    return result.completed ? { completed: true, covered: result.covered }
      : failure('the slice was not completed: read its material first, or the session moved since it was assigned; close with your report');
  }
  return failure('unknown learning operation');
}
