import { materialUnread } from './material-page.js';
import { sourceSegments } from '../../content/turn-source.js';
import { SessionDocument, DocumentBodyUnavailable } from '../../content/session-pages.js';
import { answerBytes, headThatFits, materialRead, MATERIAL_CHANGED, MATERIAL_UNREAD } from '../../core/material-pages.js';
import { RUN_ANSWER_BYTES } from '../../core/read-window.js';
import { runRefusal, REPORT_NEXT } from '../../core/run-tool-contract.js';
import { TURN_SOURCE_PAGES, TURN_SOURCE_CURSOR_MAX_CHARS, TURN_SOURCE_MAX_BYTES, recordedTurnSource, turnSourceReads, type TurnSourceRead } from '../../core/turn-source.js';
import { turnSourceState, markTurnPartial, beginTurnSourceRead } from '../../db/learning/turn-reads.js';
import { recordTurnSourceRead } from '../../db/learning/turn-reads.js';
import type { RunPrincipal, ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';
import { utf8 } from '../../hash.js';

/** Sequential source traversal: at most one document page and one stored-body window per request. */
async function readTurnSource(ctx: ToolContext, run: RunPrincipal, input: ToolInput,
  target: { tool: string; session: string; turn: string }): Promise<unknown> {
  const { tool, session, turn } = target;
  const start = { tool, op: 'get', turn_key: turn };
  const previous = recordedTurnSource(run.runContext, turn);
  const location = await turnSourceState(ctx.env.db, ctx.projectId, session, turn);
  const document = await SessionDocument.open(ctx.env, ctx.projectId, session);
  if (location === null || document === null)
    return runRefusal({ what: 'raw turn', read: true, actual: `turn ${turn} has no live source`, next: REPORT_NEXT });
  const revision = location.hash;
  const expected = materialRead(run.runContext, run.tokenId)?.sources?.find(source => source.turnKey === turn);
  if (tool === 'myco_run_cards' && expected !== undefined && expected.revision !== revision)
    return { ...runRefusal({ what: 'raw turn', read: true, actual: `source revision ${revision} differs from material revision ${expected.revision}`,
      next: { tool, op: 'material', page: 1 } }), code: MATERIAL_CHANGED };
  const cursor = typeof input.cursor === 'string' ? input.cursor : undefined;
  if (cursor !== undefined && (previous?.tokenId !== run.tokenId || previous.revision !== revision || previous.cursor !== cursor))
    return { ...runRefusal({ what: 'raw turn', read: true, actual: `source continuation ${JSON.stringify(cursor)} is not the next unread source position of this attempt and live revision`,
      next: tool === 'myco_run_cards' && previous?.revision !== revision ? { tool, op: 'material', page: 1 } : start }), code: MATERIAL_CHANGED };
  const position = cursor?.split(':').map(Number) ?? [0, 0, 0];
  if (tool === 'myco_run_cards' && location.partial === null && (location.bytes ?? 0) <= TURN_SOURCE_MAX_BYTES)
    await beginTurnSourceRead(ctx.env.db, { project: ctx.projectId, session, turn, hash: revision, run: run.runId, token: run.tokenId });
  const [pageNumber, recordNumber, offset] = position as [number, number, number];
  const held = await document.ownerPages(turn, pageNumber, TURN_SOURCE_PAGES);
  const page = held.pages[0];
  const record = page?.records[recordNumber];
  if (record === undefined) throw new Error('document_source_record_missing');
  const readBytes = previous?.tokenId === run.tokenId ? previous.bytesRead ?? 0 : 0;
  const partial = location.partial ?? ((location.bytes ?? 0) > TURN_SOURCE_MAX_BYTES || readBytes >= TURN_SOURCE_MAX_BYTES ? 'source_cap' : null);
  if (tool === 'myco_run_cards' && partial !== null) {
    for (const field of Object.keys(record.bodies ?? {})) await document.assertBodyAvailable(record, field);
    return partialReadRefusal(ctx, run, { ...target, hash: location.hash, reason: partial, bytes: Math.max(location.bytes ?? 0, readBytes) });
  }
  const around = { turn_key: turn, source_revision: revision, complete: false, next_cursor: '0'.repeat(TURN_SOURCE_CURSOR_MAX_CHARS), raw: '' };
  const weigh = (raw: string) => answerBytes({ result: { ...around, raw } });
  let raw = '', atRecord = recordNumber, atOffset = offset;
  let bodyRead = false;
  while (atRecord < page.records.length) {
    const current = page.records[atRecord]!;
    const segments = sourceSegments(current);
    const totalBytes = segments.reduce((sum, part) => sum + part.bytes, 0);
    let localOffset = atOffset;
    const segment = segments.find(part => {
      if (localOffset < part.bytes) return true;
      localOffset -= part.bytes;
      return false;
    });
    if (segment === undefined) throw new Error('document_source_offset_missing');
    if ('field' in segment && bodyRead) break;
    const text = 'text' in segment
      ? new TextDecoder('utf-8', { fatal: true }).decode(utf8(segment.text).subarray(localOffset, localOffset + RUN_ANSWER_BYTES),
        { stream: localOffset + RUN_ANSWER_BYTES < segment.bytes })
      : await document.bodyWindow(current, segment.field, localOffset, RUN_ANSWER_BYTES);
    if ('field' in segment) bodyRead = true;
    const piece = headThatFits(text, RUN_ANSWER_BYTES, head => weigh(raw + head));
    if (weigh(raw + piece) > RUN_ANSWER_BYTES) break;
    if (tool === 'myco_run_cards' && readBytes + utf8(raw + piece).length > TURN_SOURCE_MAX_BYTES)
      return partialReadRefusal(ctx, run, { ...target, hash: location.hash, reason: 'source_cap', bytes: readBytes + utf8(raw + piece).length });
    raw += piece;
    atOffset += utf8(piece).length;
    if (atOffset === totalBytes) { atRecord += 1; atOffset = 0; }
    if (piece.length < text.length) break;
  }
  const next = atRecord < page.records.length ? `${pageNumber}:${atRecord}:${atOffset}`
    : held.more ? `${pageNumber + 1}:0:0` : null;
  const receipt: TurnSourceRead = { tokenId: run.tokenId, revision, cursor: next, state: next === null ? 'complete' : 'reading', bytesRead: readBytes + utf8(raw).length };
  if (!await recordTurnSourceRead(ctx.env.db, { project: ctx.projectId, run: run.runId, session, turn,
    receipt, previous }))
    return { ...runRefusal({ what: 'raw turn', read: true, actual: 'source or its read position changed during the read', next: start }), code: MATERIAL_CHANGED };
  return { turn_key: turn, source_revision: revision, raw, complete: next === null, ...(next === null ? {} : { next_cursor: next }) };
}

/** A complete card requires every omitted source segment of its own turns. */
export function turnSourceUnread(run: RunPrincipal, tool: string, required: readonly { turnKey: string; revision: string }[] = []) {
  const reads = turnSourceReads(run.runContext, run.tokenId);
  const missing = required.find(source => reads.get(source.turnKey)?.state !== 'complete' || reads.get(source.turnKey)?.revision !== source.revision);
  const turn = missing?.turnKey;
  if (turn === undefined) return null;
  const read = reads.get(turn);
  const cursor = read?.state === 'reading' && (missing === undefined || read.revision === missing.revision) ? read.cursor : null;
  return { ...runRefusal({ what: 'material-dependent operation', actual: `turn ${turn} still has unread source; coverage and a complete card require the whole turn`,
    repair: 'Continue reading this turn; cards for other turns may be written now.',
    next: { tool, op: 'get', turn_key: turn, ...(cursor === null ? {} : { cursor }) } }), code: MATERIAL_UNREAD };
}

async function partialReadRefusal(ctx: ToolContext, run: RunPrincipal,
  options: { tool: string; session: string; turn: string; hash: string; reason: string; bytes: number }): Promise<unknown> {
  const { tool, session, turn, reason, bytes } = options;
  if (tool === 'myco_run_cards') await markTurnPartial(ctx.env.db, { project: ctx.projectId, session, turn, hash: options.hash, reason });
  const gate = materialUnread(run);
  const next = gate !== null ? { tool, op: 'material', page: gate.next_page, ...(gate.revision === undefined ? {} : { revision: gate.revision }) }
    : tool === 'myco_run_cards' ? { tool, op: 'write', revision: materialRead(run.runContext, run.tokenId)!.revision } : { tool, op: 'complete' };
  return { ...runRefusal({ what: 'full turn source', read: true,
    actual: `turn ${turn}: ${reason}; requested reading is ${bytes} UTF-8 bytes, the per-turn card read limit is ${TURN_SOURCE_MAX_BYTES}`,
    repair: tool === 'myco_run_cards' ? 'Write its card from the material excerpt; it is stored as written from part of the turn.' : 'Use the card; this optional raw read does not block learning.',
    next }), code: reason === 'body_missing' ? 'source_body_unavailable' : 'turn_source_partial' };
}

export async function serveTurnSource(ctx: ToolContext, run: RunPrincipal, input: ToolInput,
  target: { tool: string; session: string; turn: string }): Promise<unknown> {
  try { return await readTurnSource(ctx, run, input, target); }
  catch (error) {
    if (!(error instanceof DocumentBodyUnavailable)) throw error;
    const state = await turnSourceState(ctx.env.db, ctx.projectId, target.session, target.turn);
    if (state === null) return runRefusal({ what: 'raw turn', read: true, actual: 'turn source is no longer live', next: REPORT_NEXT });
    return partialReadRefusal(ctx, run, { ...target, hash: state.hash, reason: 'body_missing', bytes: state.bytes ?? 0 });
  }
}
