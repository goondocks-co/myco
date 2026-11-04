/**
 * `myco_run_cards`: the card stage's own material and writes.
 *
 * It takes no session argument. The session and the turns are the ones the claim wrote into the run's context, so a
 * run reads and writes exactly its assignment: the trimmed input of each turn, read from the turn's pages and served in
 * answers the harness holds whole, and one card per turn.
 */
import { failure, runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';
import { commitAttributedWrite } from '../../core/runs.js';
import { cardMaterialPages, cardsWrittenStatement, parseCardWrites, writeRunCards } from '../../core/turn-cards.js';
import { trimTurn } from '../../core/turn-card-rules.js';
import { SessionDocument } from '../../content/session-pages.js';
import { documentTurnInput } from '../../content/turn-material.js';
import type { CardAssignment } from '../../core/learning-stages.js';
import { CARD_TOOL } from '../../core/tool-catalogue.js';
import { assignmentOf } from './run-learning.js';

export async function handleRunCards(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const run = runOf(ctx, CARD_TOOL);
  const held = assignmentOf<CardAssignment>(run.runContext, 'cards');
  if (held === null) return failure('this run carries no card assignment');
  const { db } = ctx.env;
  const scope = { projectId: ctx.projectId };
  if (input.op === 'material') {
    const page = input.page === undefined ? 1 : input.page as number;
    if (!Number.isInteger(page) || page < 1) return failure('page is a whole number from 1');
    const turns = [];
    const document = await SessionDocument.open(ctx.env, ctx.projectId, held.sessionId);
    for (const turn of held.assignment.turns) {
      const input = await documentTurnInput(ctx.env, ctx.projectId, held.sessionId, turn.turnKey, document);
      if (input !== null) turns.push({ turn_key: turn.turnKey, input: trimTurn(input).text });
    }
    const pages = cardMaterialPages(held.sessionId, turns);
    const served = pages[page - 1];
    if (served === undefined) return failure(`this run's material ends at page ${pages.length}`);
    return { session_id: held.sessionId, page, next_page: page < pages.length ? page + 1 : null, turns: served };
  }
  if (input.op === 'write') {
    const writes = parseCardWrites(input.cards, new Set(held.assignment.turns.map((turn) => turn.turnKey)));
    if (typeof writes === 'string') return failure(writes);
    const result = await writeRunCards(ctx.env, ctx.projectId, held.sessionId, held.assignment.turns, writes,
      { runId: run.runId, model: run.model }, ctx.now);
    await commitAttributedWrite(db, scope, cardsWrittenStatement(db, ctx.projectId, held.sessionId, run.runId),
      { runId: run.runId, toolName: CARD_TOOL, op: 'write', recordedAt: ctx.now, detail: { written: result.written } });
    return { written: result.written, changed_since_served: result.changed };
  }
  return failure('unknown card operation');
}
