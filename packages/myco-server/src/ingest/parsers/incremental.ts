import { ownedLines, unfinishedCalls, recordId, legacyRecordId, replyChunks, responseBound, REPLY_SEPARATOR,
  type DerivedEvent, type TranscriptParser, type ParserState, type ReplyPart } from './index.js';
import { LEGACY_RECORD_ID_SCHEME, isReplySource, RecordSourceInvalid } from '@goondocks/myco-shared/record-identity';
import { utf8 } from '../../hash.js';

/** Retained tool calls above this count become explicit failures. */
export const MAX_PENDING_CALLS = 32;
export const PENDING_CALL_LIMIT_ERROR = 'tool call exceeded the pending-call limit';
const textBytes = (text: string): number => utf8(JSON.stringify(text)).length - 2;

/** One continuation owns turn replies, unresolved calls and every terminal outcome. */
export function withParserContinuation(parser: TranscriptParser): TranscriptParser {
  return {
    ...parser,
    async parse(input) {
      const state: ParserState = input.state ?? {};
      if (input.recordScheme !== LEGACY_RECORD_ID_SCHEME && state.reply?.parts.some(part => !isReplySource(part.source))) {
        throw new RecordSourceInvalid();
      }
      const events: DerivedEvent[] = [];
      let openPromptId = input.openPromptId;
      // The keys this traversal claims, carried across its lines and never beyond it.
      const claims = new Map<string, string>();
      const transcriptMeta = input.transcriptMeta ?? parser.headerContext?.(input.lines);
      const emitReply = async (parts: readonly ReplyPart[], promptId?: string): Promise<void> => {
        for (const part of replyChunks(parts)) {
          if (input.recordScheme !== LEGACY_RECORD_ID_SCHEME && !isReplySource(part.source)) throw new RecordSourceInvalid();
          const request = { kind: 'response' as const, offset: part.offset };
          const legacyId = await legacyRecordId(input, request);
          events.push({ kind: 'response', offset: part.offset, createdAt: part.createdAt, source: part.source, legacyId,
            payload: { responseId: part.source === undefined ? legacyId : await recordId(input, parser.agent, { ...request, source: part.source }), promptId, text: part.text } });
        }
      };
      const flushReply = async (): Promise<void> => {
        if (state.reply === undefined) return;
        await emitReply(state.reply.parts, state.reply.promptId);
        delete state.reply;
      };
      const appendReply = async (event: DerivedEvent): Promise<void> => {
        const part = { text: String(event.payload.text), offset: event.offset, createdAt: event.createdAt, source: event.source };
        // A reply is one prompt's: a line naming another prompt than the reply held starts its own.
        const promptId = typeof event.payload.promptId === 'string' ? event.payload.promptId : undefined;
        if (state.reply !== undefined && state.reply.promptId !== promptId) await flushReply();
        const bound = responseBound();
        const bytes = textBytes(part.text);
        if (state.reply !== undefined && (state.reply.chars + REPLY_SEPARATOR.length + part.text.length > bound.chars
          || state.reply.bytes + textBytes(REPLY_SEPARATOR) + bytes > bound.bytes)) await flushReply();
        const kept = part.text.length > bound.chars || bytes > bound.bytes ? replyChunks([part])[0] : part;
        if (kept === undefined) return;
        if (state.reply === undefined) state.reply = { parts: [], promptId, chars: 0, bytes: 0 };
        if (state.reply.parts.length > 0) {
          state.reply.chars += REPLY_SEPARATOR.length;
          state.reply.bytes += textBytes(REPLY_SEPARATOR);
        }
        state.reply.parts.push(kept);
        state.reply.chars += kept.text.length;
        state.reply.bytes += textBytes(kept.text);
      };
      for (const line of ownedLines(input.lines, input.sessionId, parser.continuation)) {
        const derived = await parser.parse({ ...input, terminal: undefined, state, transcriptMeta, lines: [line], openPromptId, claims });
        for (const event of derived) {
          if (event.kind === 'prompt' && event.opensTurn !== false && typeof event.payload.promptId === 'string') {
            await flushReply();
            openPromptId = event.payload.promptId;
          }
          if (event.kind === 'response') await appendReply(event);
          else events.push(event);
        }
        if (parser.endsTurn?.(line.value) === true) await flushReply();
        const pending = Object.entries(state.pending ?? {});
        for (const [id, call] of pending.slice(0, Math.max(0, pending.length - MAX_PENDING_CALLS))) {
          events.push(...unfinishedCalls([[id, call]], 'pending_limit', PENDING_CALL_LIMIT_ERROR));
          delete state.pending![id];
        }
      }
      if (input.terminal !== undefined || input.state === undefined) {
        await flushReply();
        if (input.terminal !== 'turn_end') {
          events.push(...unfinishedCalls(Object.entries(state.pending ?? {}), 'no_result'));
          state.pending = {};
        }
      }
      if (input.recordScheme === LEGACY_RECORD_ID_SCHEME && state.reply !== undefined) {
        for (const part of state.reply.parts) delete part.source;
      }
      return events.sort((a, b) => a.offset - b.offset);
    },
  };
}
