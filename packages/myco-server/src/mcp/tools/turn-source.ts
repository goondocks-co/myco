import type { DocRecord } from '../../content/document.js';
import { SessionDocument } from '../../content/session-pages.js';
import { answerBytes, headThatFits, materialRead, MATERIAL_CHANGED, MATERIAL_UNREAD } from '../../core/material-pages.js';
import { RUN_ANSWER_BYTES } from '../../core/read-window.js';
import { runRefusal, REPORT_NEXT } from '../../core/run-tool-contract.js';
import { TURN_SOURCE_PAGES, TURN_SOURCE_CURSOR_MAX_CHARS, recordedTurnSource, turnSourceReads, type TurnSourceRead } from '../../core/turn-source.js';
import { promptLocator } from '../../db/documents/prompt-locator.js';
import { recordTurnSourceRead } from '../../db/learning/turn-reads.js';
import type { RunPrincipal, ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';
import { utf8 } from '../../hash.js';

type SourceSegment = { text: string; bytes: number } | { field: string; bytes: number };

function sourceSegments(record: DocRecord): SourceSegment[] {
  const { bodies, src: _src, ev: _ev, ...fields } = record;
  const segments: SourceSegment[] = [];
  for (const [field, ref] of Object.entries(bodies ?? {})) fields[field] = { stored_body_bytes: ref.bytes };
  const header = `${JSON.stringify(fields)}\n`;
  segments.push({ text: header, bytes: utf8(header).length });
  for (const [field, ref] of Object.entries(bodies ?? {})) {
    const label = `\nBODY ${field}:\n`;
    segments.push({ text: label, bytes: utf8(label).length }, { field, bytes: ref.bytes });
  }
  return segments;
}

/** Sequential source traversal: at most one document page and one stored-body window per request. */
export async function serveTurnSource(ctx: ToolContext, run: RunPrincipal, input: ToolInput,
  target: { tool: string; session: string; turn: string }): Promise<unknown> {
  const { tool, session, turn } = target;
  const start = { tool, op: 'get', turn_key: turn };
  const previous = recordedTurnSource(run.runContext, turn);
  const location = await promptLocator(ctx.env.db, ctx.projectId, session, turn);
  const document = await SessionDocument.open(ctx.env, ctx.projectId, session);
  if (location === null || document === null || location.documentRevision === null)
    return runRefusal({ what: 'raw turn', read: true, actual: `turn ${turn} has no live source`, next: REPORT_NEXT });
  const revision = `${location.generation}:${location.documentRevision}`;
  const expected = materialRead(run.runContext, run.tokenId)?.sources?.find(source => source.turnKey === turn);
  if (tool === 'myco_run_cards' && expected !== undefined && expected.revision !== revision)
    return { ...runRefusal({ what: 'raw turn', read: true, actual: `source revision ${revision} differs from material revision ${expected.revision}`,
      next: { tool, op: 'material', page: 1 } }), code: MATERIAL_CHANGED };
  const cursor = typeof input.cursor === 'string' ? input.cursor : undefined;
  if (cursor !== undefined && (previous?.tokenId !== run.tokenId || previous.revision !== revision || previous.cursor !== cursor))
    return { ...runRefusal({ what: 'raw turn', read: true, actual: `source continuation ${JSON.stringify(cursor)} is not the next unread source position of this attempt and live revision`,
      next: tool === 'myco_run_cards' && previous?.revision !== revision ? { tool, op: 'material', page: 1 } : start }), code: MATERIAL_CHANGED };
  const position = cursor?.split(':').map(Number) ?? [0, 0, 0];
  const [pageNumber, recordNumber, offset] = position as [number, number, number];
  const held = await document.ownerPages(turn, pageNumber, TURN_SOURCE_PAGES);
  const page = held.pages[0];
  const record = page?.records[recordNumber];
  if (record === undefined) throw new Error('document_source_record_missing');
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
    raw += piece;
    atOffset += utf8(piece).length;
    if (atOffset === totalBytes) { atRecord += 1; atOffset = 0; }
    if (piece.length < text.length) break;
  }
  const next = atRecord < page.records.length ? `${pageNumber}:${atRecord}:${atOffset}`
    : held.more ? `${pageNumber + 1}:0:0` : null;
  const receipt: TurnSourceRead = { tokenId: run.tokenId, revision, cursor: next, state: next === null ? 'complete' : 'reading' };
  if (!await recordTurnSourceRead(ctx.env.db, { project: ctx.projectId, run: run.runId, session, turn,
    generation: location.generation, documentRevision: location.documentRevision, receipt, previous }))
    return { ...runRefusal({ what: 'raw turn', read: true, actual: 'source or its read position changed during the read', next: start }), code: MATERIAL_CHANGED };
  return { turn_key: turn, source_revision: revision, raw, complete: next === null, ...(next === null ? {} : { next_cursor: next }) };
}

/** A card needs all omitted source; a learning read that was opened must finish before any write. */
export function turnSourceUnread(run: RunPrincipal, tool: string, required: readonly { turnKey: string; revision: string }[] = [], unavailable: readonly string[] = []) {
  const reads = turnSourceReads(run.runContext, run.tokenId);
  const missing = required.find(source => reads.get(source.turnKey)?.state !== 'complete' || reads.get(source.turnKey)?.revision !== source.revision);
  const partial = [...reads].find(([key, read]) => read.state === 'reading' && !unavailable.includes(key));
  const turn = missing?.turnKey ?? partial?.[0];
  if (turn === undefined) return null;
  const read = reads.get(turn);
  const cursor = read?.state === 'reading' && (missing === undefined || read.revision === missing.revision) ? read.cursor : null;
  return { ...runRefusal({ what: 'material-dependent operation', actual: `turn ${turn} still has unread source; coverage and a complete card require the whole turn`,
    repair: 'Continue reading; if the run deadline prevents completion, report the unfinished turn and end failed. It remains pending.',
    next: { tool, op: 'get', turn_key: turn, ...(cursor === null ? {} : { cursor }) } }), code: MATERIAL_UNREAD };
}
