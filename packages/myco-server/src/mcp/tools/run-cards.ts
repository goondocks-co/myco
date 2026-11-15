import { runRefusal, REPORT_NEXT } from '../../core/run-tool-contract.js';
/**
 * `myco_run_cards`: the card stage's own material and writes.
 *
 * It takes no session argument. The session and the turns are the ones the claim wrote into the run's context, so a
 * run reads and writes exactly its assignment: the trimmed input of each turn, read from the turn's pages and served in
 * answers the harness holds whole, and one card per turn. A write is admitted only once this attempt has read every page
 * of the last revision it started reading, including the full source behind incomplete previews.
 */
import { runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';
import { commitAttributedWrite } from '../../db/runs/attribution.js';
import {
  cardMaterialPages,
  cardsWrittenStatement,
  parseCardWrites,
  writeRunCards,
  runCardsRemaining,
  type CardMaterial,
} from '../../core/turn-cards.js';
import { trimTurn } from '../../core/turn-card-rules.js';
import { SessionDocument } from '../../content/session-pages.js';
import { promptLocator } from '../../db/documents/prompt-locator.js';
import { serveTurnSource } from './turn-source.js';
import { documentTurn } from '../../content/turn-material.js';
import type { CardAssignment } from '../../core/learning-stages.js';
import { CARD_TOOL } from '../../core/tool-catalogue.js';
import { materialUnread, servePage } from './material-page.js';
import { assignmentOf } from '../../db/run-context.js';
import { materialRead, MATERIAL_CHANGED } from '../../core/material-pages.js';

export async function handleRunCards(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const run = runOf(ctx, CARD_TOOL);
  const held = assignmentOf<CardAssignment>(run.runContext, 'cards');
  if (held === null) return runRefusal({ what: 'cards', actual: 'this run carries no card assignment', next: REPORT_NEXT });
  const { db } = ctx.env;
  const scope = { projectId: ctx.projectId };
  if (input.op === 'material') {
    const turns: CardMaterial[] = [];
    const unavailable: string[] = [];
    const document = await SessionDocument.open(ctx.env, ctx.projectId, held.sessionId);
    for (const turn of held.assignment.turns) {
      const material = await documentTurn(ctx.env, ctx.projectId, held.sessionId, turn.turnKey, document);
      if (material !== null) {
        const trimmed = trimTurn(material.input);
        const location = await promptLocator(db, ctx.projectId, held.sessionId, turn.turnKey);
        if (location === null || location.documentRevision === null || location.generation !== document?.generation)
          return { ...runRefusal({ what: 'card material', read: true, actual: 'the live source changed while material was read',
            next: { tool: CARD_TOOL, op: 'material', page: 1 } }), code: MATERIAL_CHANGED };
        turns.push({ turn_key: turn.turnKey, input: trimmed.text, complete: material.complete && trimmed.complete,
          source_revision: `${location.generation}:${location.documentRevision}` });
      }
      else if (document !== null) unavailable.push(turn.turnKey);
    }
    const page = await servePage(ctx, run, input, turns, { paginate: () => cardMaterialPages(held.sessionId, turns), unavailable,
      sources: turns.filter(turn => !turn.complete).map(turn => ({ turnKey: turn.turn_key, revision: turn.source_revision! })) });
    if ('refusal' in page) return page.refusal;
    return { session_id: held.sessionId, revision: page.revision, page: page.page, ...page.next, turns: page.served };
  }
  if (input.op === 'get') {
    const turn = held.assignment.turns.find(turn => turn.turnKey === input.turn_key);
    if (turn === undefined) return runRefusal({ what: 'raw turn', read: true, actual: `turn_key ${JSON.stringify(input.turn_key)} is not assigned`,
      next: { tool: CARD_TOOL, op: 'material', page: 1 } });
    return serveTurnSource(ctx, run, input, { tool: CARD_TOOL, session: held.sessionId, turn: turn.turnKey });
  }
  if (input.op === 'write') {
    const unread = materialUnread(run);
    if (unread !== null) return unread;
    const read = materialRead(run.runContext, run.tokenId)!;
    if (input.revision !== read.revision)
      return {
        ...runRefusal({
          what: 'cards',
          actual: `revision is ${JSON.stringify(input.revision) ?? 'missing'}; expected ${JSON.stringify(read.revision)}`,
          next: { tool: CARD_TOOL, op: 'material', page: 1 },
        }),
        code: MATERIAL_CHANGED,
      };
    const writes = parseCardWrites(input.cards, new Set(held.assignment.turns.map((turn) => turn.turnKey)));
    if (typeof writes === 'string')
      return runRefusal({
        what: 'cards',
        actual: writes,
        repair: 'Correct the named card and retain the material revision.',
        next: { tool: CARD_TOOL, op: 'write', revision: read.revision },
      });
    const result = await writeRunCards(
      ctx.env,
      ctx.projectId,
      held.sessionId,
      held.assignment.turns,
      writes,
      { runId: run.runId, model: run.model },
      ctx.now,
      held.assignment.turns.filter((turn) => read.unavailable?.includes(turn.turnKey)),
    );
    if (writes.length === 0 && read.items > 0) {
      const unavailable = new Set(read.unavailable ?? []);
      const missing = (await runCardsRemaining(db, ctx.projectId, held.sessionId, run.runId, held.assignment.turns)).filter(
        (key) => !unavailable.has(key),
      );
      if (missing.length > 0)
        return runRefusal({
          what: 'cards',
          actual: `missing turns: ${missing.join(', ')}; each needs exactly one card`,
          next: { tool: CARD_TOOL, op: 'write', revision: read.revision },
          repair: 'Supply cards naming these turns.',
        });
    }
    await commitAttributedWrite(db, scope, cardsWrittenStatement(db, ctx.projectId, held.sessionId, run.runId, held.assignment.turns), {
      runId: run.runId,
      toolName: CARD_TOOL,
      op: 'write',
      recordedAt: ctx.now,
      detail: { written: result.written },
    });
    return { written: result.written, changed_since_served: result.changed };
  }
  return runRefusal({
    what: 'cards',
    actual: `unknown op ${JSON.stringify(input.op)}`,
    next: { tool: CARD_TOOL, op: 'material', page: 1 },
  });
}
