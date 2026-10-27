/**
 * Cursor's agent transcript, as both `cursor-agent` and the IDE's agent write
 * it under `~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl`:
 * one JSON object per line, `role` naming the speaker and the words at
 * `message.content` as an array of typed blocks (`text`, `tool_use`). A turn
 * closes with `{"type":"turn_ended"}`. Lines carry no timestamp.
 *
 * A person's words arrive wrapped: `<user_query>` holds what they typed, beside
 * blocks the agent adds (`<timestamp>`, `<image_files>`, `<attached_files>`).
 * A user line that is nothing but such blocks (`<git_status>`, the subagent
 * catalogue) is context the agent injected, not a prompt; any other user line
 * with no `<user_query>` keeps its text as typed. Cursor masks its reasoning
 * in assistant text with a literal `[REDACTED]`, dropped wherever it stands.
 *
 * Cursor's transcript carries NO tool results. That is a property of the
 * format, not of any one file, so this parser declares `no_tool_results` and a
 * session captured from it is structurally incomplete: `transcripts.fidelity`
 * records it and extraction excludes the session. Deriving tool calls without
 * their results would state as fact something the file cannot support.
 */
import {
  recordSource, isBlock, lineTime, promptIdAtOffset, str, textOf,
  type DerivedEvent, type ParserInput, type ReplyPart, type TranscriptParser,
} from './index.js';


/** The line that closes a turn. */
const TURN_ENDED = 'turn_ended';

import { cursorPromptText } from '@goondocks/myco-shared/prompt-text';
export { cursorPromptText as promptTextOf } from '@goondocks/myco-shared/prompt-text';

const REDACTED = /[ \t]*\[REDACTED\][ \t]*/g;

/** Assistant text with Cursor's `[REDACTED]` reasoning masks removed wherever they stand. */
export function responseTextOf(text: string): string {
  return text
    .split('\n')
    .flatMap((line) => {
      if (!line.includes('[REDACTED]')) return [line];
      const kept = line.replace(REDACTED, ' ').trim();
      return kept === '' ? [] : [kept];
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const cursorParser: TranscriptParser = {
  agent: 'cursor',
  fidelity: 'no_tool_results',
  schemes: ['offset-v1', 'offset-v2'],
  planTags: [],
  endsTurn: (value) => value.type === TURN_ENDED,

  async parse(input: ParserInput): Promise<DerivedEvent[]> {
    const { lines, sessionId, now, openPromptId } = input;
    const events: DerivedEvent[] = [];
    let promptId: string | undefined = openPromptId;
    let reply: { parts: ReplyPart[]; promptId?: string } | null = null;

    const flushReply = async (): Promise<void> => {
      if (reply === null) return;
      const held = reply;
      reply = null;
      for (const chunk of held.parts) {
        events.push({
          kind: 'response',
          payload: { promptId: held.promptId, text: chunk.text },
          source: chunk.source,
          createdAt: chunk.createdAt,
          offset: chunk.offset,
        });
      }
    };

    for (const { value, offset, undatedAt } of lines) {
      if (str(value.type) === TURN_ENDED) {
        await flushReply();
        continue;
      }
      const role = str(value.role);
      if (role !== 'user' && role !== 'assistant') continue;
      const message = isBlock(value.message) ? value.message : undefined;
      const raw = textOf(message?.content);
      const text = role === 'user' ? cursorPromptText(raw) : responseTextOf(raw);
      if (text === '') continue;
      const createdAt = lineTime(value, now, undatedAt);

      if (role === 'user') {
        await flushReply();
        promptId = await promptIdAtOffset('cursor-prompt', sessionId, offset, input);
        events.push({ kind: 'prompt', payload: { promptId, text, origin: 'user', promptKind: 'user_query' }, createdAt, offset });
        continue;
      }
      if (reply === null) reply = { parts: [], promptId };
      reply.parts.push({ text, offset, createdAt, source: recordSource(input, this.agent, { kind: 'response', record: value, block: 0 }) });
    }

    await flushReply();
    return events.sort((a, b) => a.offset - b.offset);
  },
};
