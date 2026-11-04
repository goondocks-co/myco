/**
 * `myco_run_cards`: the card stage's own material and writes.
 *
 * It takes no session argument. The session and the turns are the ones the claim wrote into the run's context, so a
 * run reads and writes exactly its assignment: the trimmed input of each turn, read from the turn's pages and served in
 * answers the harness holds whole, and one card per turn. A write is admitted only once this attempt has read every page
 * of the last revision it started reading.
 */
import { failure, runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';
import { commitAttributedWrite } from '../../core/runs.js';
import { cardMaterialPages, cardsWrittenStatement, parseCardWrites, writeRunCards, type CardMaterial } from '../../core/turn-cards.js';
import { trimTurn } from '../../core/turn-card-rules.js';
import { SessionDocument } from '../../content/session-pages.js';
import { documentTurnInput } from '../../content/turn-material.js';
import type { CardAssignment } from '../../core/learning-stages.js';
import { CARD_TOOL } from '../../core/tool-catalogue.js';
import { materialUnread, servePage } from './material-page.js';
import { assignmentOf } from '../../db/run-context.js';
import { materialRead, MATERIAL_CHANGED } from '../../core/material-pages.js';

export async function handleRunCards(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const run = runOf(ctx, CARD_TOOL);
  const held = assignmentOf<CardAssignment>(run.runContext, 'cards');
  if (held === null) return failure('this run carries no card assignment');
  const { db } = ctx.env;
  const scope = { projectId: ctx.projectId };
  if (input.op === 'material') {
    const turns: CardMaterial[] = [];
    const unavailable: string[] = [];
    const document = await SessionDocument.open(ctx.env, ctx.projectId, held.sessionId);
    for (const turn of held.assignment.turns) {
      const material = await documentTurnInput(ctx.env, ctx.projectId, held.sessionId, turn.turnKey, document);
      if (material !== null) turns.push({ turn_key: turn.turnKey, input: trimTurn(material).text });
      else unavailable.push(turn.turnKey);
    }
    const page = await servePage(ctx, run, input, turns, () => cardMaterialPages(held.sessionId, turns), undefined, unavailable);
    if ('refusal' in page) return page.refusal;
    return { session_id: held.sessionId, revision: page.revision, page: page.page, ...page.next, turns: page.served };
  }
  if (input.op === 'write') {
    const unread = materialUnread(run);
    if (unread !== null) return unread;
    const read = materialRead(run.runContext, run.tokenId)!;
    if (input.revision !== read.revision) return { ...failure('each card write carries the revision read by this attempt; read the material again if it changed'), code: MATERIAL_CHANGED };
    const writes = parseCardWrites(input.cards, new Set(held.assignment.turns.map((turn) => turn.turnKey)));
    if (typeof writes === 'string') return failure(writes);
    const result = await writeRunCards(ctx.env, ctx.projectId, held.sessionId, held.assignment.turns, writes,
      { runId: run.runId, model: run.model }, ctx.now,
      held.assignment.turns.filter(turn => read.unavailable?.includes(turn.turnKey)));
    await commitAttributedWrite(db, scope, cardsWrittenStatement(db, ctx.projectId, held.sessionId, run.runId, held.assignment.turns),
      { runId: run.runId, toolName: CARD_TOOL, op: 'write', recordedAt: ctx.now, detail: { written: result.written } });
    return { written: result.written, changed_since_served: result.changed };
  }
  return failure('unknown card operation');
}
