import { runRefusal, REPORT_NEXT } from '../../core/run-tool-contract.js';
import { assignmentOf } from '../../db/run-context.js';
/**
 * `myco_run_learning`: session learning's own material and completion.
 *
 * It takes no session argument. The session and the slice are the ones the claim wrote into the run's context, so a
 * run reads and completes exactly its assignment: it reads its slice's cards in answers the harness holds whole, may open
 * the raw turn behind a high-signal card from the turn's pages, and completes the slice. A completion or a spore write is
 * admitted only once this attempt has read every page of the last revision it started reading.
 */
import { runOf, type RunPrincipal, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';
import { recordServedPrompts } from '../../core/served-material.js';
import { RUN_ANSWER_BYTES } from '../../core/read-window.js';
import { answerBytes, headThatFits } from '../../core/material-pages.js';
import type { TurnInput } from '../../core/turn-card-rules.js';
import { documentTurnInput } from '../../content/turn-material.js';
import {
  assignedCards,
  completeLearning,
  HANDOFF_MAX_BYTES,
  learningMaterialPages,
  type LearningAssignment,
  type LearningMaterial,
} from '../../core/learning-sessions.js';
import { LEARNING_TOOL } from '../../core/tool-catalogue.js';
import { materialUnread, servePage } from './material-page.js';

/** The refusal of a learning run's write ahead of the pages of its slice; null for a run with no slice, or one that has read it all. */
export function learningMaterialUnread(run: RunPrincipal): ReturnType<typeof materialUnread> {
  return assignmentOf<LearningAssignment>(run.runContext, 'learning') === null ? null : materialUnread(run);
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
  return lines.join('\n');
}

/** The room a cut raw turn keeps for the line that counts what it leaves out. */
const CUT_LINE_BYTES = 64;

/** One raw turn as an answer the harness holds whole; what does not fit is cut, and the cut says how much. */
function rawTurnAnswer(turnKey: string, text: string): { turn_key: string; raw: string } {
  const weigh = (raw: string) => answerBytes({ result: { turn_key: turnKey, raw } });
  if (weigh(text) <= RUN_ANSWER_BYTES) return { turn_key: turnKey, raw: text };
  const head = headThatFits(text, RUN_ANSWER_BYTES - CUT_LINE_BYTES, weigh);
  return { turn_key: turnKey, raw: `${head}\n[… ${text.length - head.length} more characters]` };
}

export async function handleRunLearning(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const run = runOf(ctx, LEARNING_TOOL);
  const held = assignmentOf<LearningAssignment>(run.runContext, 'learning');
  if (held === null) return runRefusal({ what: 'learning', actual: 'this run carries no learning assignment', next: REPORT_NEXT });
  const { db } = ctx.env;
  const scope = { projectId: ctx.projectId };
  const cards = await assignedCards(db, ctx.projectId, held.sessionId, held.assignment);
  if (input.op === 'material') {
    const entries: LearningMaterial[] = cards.map((card) => ({ turn_key: card.turnKey, signal: card.signal, card: card.card }));
    const opening = {
      handoff: held.assignment.handoff,
      more_slices: held.assignment.more,
      ...(cards.length < held.assignment.turns.length ? { changed_since_assignment: held.assignment.turns.length - cards.length } : {}),
    };
    const page = await servePage(
      ctx,
      run,
      input,
      entries,
      () => learningMaterialPages(held.sessionId, opening, entries),
      async (served) => {
        const onPage = new Set(served.map((entry) => entry.turn_key));
        await recordServedPrompts(
          db,
          scope,
          run.runId,
          cards
            .filter((card) => onPage.has(card.turnKey))
            .flatMap((card) => card.promptIds.map((promptId) => ({ promptId, sessionId: held.sessionId, createdAt: 0, endedAt: null }))),
          ctx.now,
        );
      },
    );
    if ('refusal' in page) return page.refusal;
    return {
      session_id: held.sessionId,
      ...(page.page === 1 ? opening : {}),
      revision: page.revision,
      page: page.page,
      ...page.next,
      cards: page.served,
    };
  }
  if (input.op === 'get') {
    const card = cards.find((c) => c.turnKey === input.turn_key);
    if (card === undefined)
      return runRefusal({
        what: 'raw turn read',
        actual: `turn_key ${JSON.stringify(input.turn_key)} names no card of this slice`,
        next: { tool: LEARNING_TOOL, op: 'material', page: 1 },
      });
    if (card.signal !== 'high')
      return runRefusal({
        what: 'raw turn read',
        actual: `turn ${card.turnKey} has signal ${card.signal}; expected high`,
        next: { tool: LEARNING_TOOL, op: 'material', page: 1 },
      });
    const turn = await documentTurnInput(ctx.env, ctx.projectId, held.sessionId, card.turnKey);
    return turn === null
      ? runRefusal({ what: 'raw turn read', actual: `turn ${card.turnKey} is no longer held`, next: REPORT_NEXT })
      : rawTurnAnswer(card.turnKey, rawTurnText(turn));
  }
  if (input.op === 'complete') {
    const unread = materialUnread(run);
    if (unread !== null) return unread;
    const handoff = typeof input.handoff === 'string' ? input.handoff : '';
    if (new TextEncoder().encode(handoff).length > HANDOFF_MAX_BYTES)
      return runRefusal({
        what: 'learning completion',
        actual: `handoff is ${new TextEncoder().encode(handoff).length} UTF-8 bytes; the limit is ${HANDOFF_MAX_BYTES}`,
        next: { tool: LEARNING_TOOL, op: 'complete' },
        repair: 'Shorten handoff and supply it again.',
      });
    const result = await completeLearning(db, ctx.projectId, held.sessionId, run.runId, held.assignment, handoff, ctx.now);
    return result.completed
      ? { completed: true, covered: result.covered }
      : runRefusal({ what: 'learning completion', actual: 'the session moved since this slice was assigned', next: REPORT_NEXT });
  }
  return runRefusal({
    what: 'learning',
    actual: `unknown op ${JSON.stringify(input.op)}`,
    next: { tool: LEARNING_TOOL, op: 'material', page: 1 },
  });
}
