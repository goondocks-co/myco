/**
 * `myco_run_cards`: the card stage's own material and writes.
 *
 * It takes no session argument. The session and the turns are the ones the claim wrote into the run's context, so a
 * run reads and writes exactly its assignment: the trimmed input of each turn, and one card per turn.
 */
import { failure, runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';
import { commitAttributedWrite } from '../../core/runs.js';
import { cardRecord, cardsWrittenStatement, parseCardWrites, writeRunCards } from '../../core/turn-cards.js';
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
    const turns = [];
    for (const turn of held.assignment.turns) {
      const record = await cardRecord(db, scope, held.sessionId, turn);
      if (record !== null) turns.push({ turn_key: turn.turnKey, input: record.trimmed.text });
    }
    return { session_id: held.sessionId, turns };
  }
  if (input.op === 'write') {
    const writes = parseCardWrites(input.cards, new Set(held.assignment.turns.map((turn) => turn.turnKey)));
    if (typeof writes === 'string') return failure(writes);
    const used = await db.prepare('SELECT model FROM agent_runs WHERE project_id = ? AND id = ?').bind(ctx.projectId, run.runId).first<{ model: string | null }>();
    const result = await writeRunCards(ctx.env, ctx.projectId, held.sessionId, held.assignment.turns, writes,
      { runId: run.runId, model: used?.model ?? null }, ctx.now);
    await commitAttributedWrite(db, scope, cardsWrittenStatement(db, ctx.projectId, held.sessionId, run.runId),
      { runId: run.runId, toolName: CARD_TOOL, op: 'write', recordedAt: ctx.now, detail: { written: result.written } });
    return { written: result.written, changed_since_served: result.changed };
  }
  return failure('unknown card operation');
}
