/**
 * Cursor's agent transcript: the JSONL variant, `type` naming the role and the
 * words at `message.content` as a string or an array of typed blocks.
 *
 * Cursor's transcript carries NO tool results. That is a property of the
 * format, not of any one file, so this parser declares `no_tool_results` and a
 * session captured from it is structurally incomplete: `transcripts.fidelity`
 * records it and extraction excludes the session. Deriving tool calls without
 * their results would state as fact something the file cannot support.
 */
import { uuidv5 } from '../../hash.js';
import {
  isBlock, lineTime, str, textOf,
  type DerivedEvent, type ParserInput, type TranscriptParser,
} from './index.js';

const promptIdAt = (sessionId: string, offset: number): Promise<string> => uuidv5('cursor-prompt', sessionId, String(offset));
const responseIdAt = (sessionId: string, offset: number): Promise<string> => uuidv5('response', sessionId, String(offset));

export const cursorParser: TranscriptParser = {
  agent: 'cursor',
  fidelity: 'no_tool_results',

  async parse({ lines, sessionId, now }: ParserInput): Promise<DerivedEvent[]> {
    const events: DerivedEvent[] = [];
    let promptId: string | undefined;
    let reply: { text: string[]; offset: number; createdAt: number; promptId?: string } | null = null;

    const flushReply = async (): Promise<void> => {
      if (reply === null) return;
      const held = reply;
      reply = null;
      const text = held.text.join('\n\n').trim();
      if (text === '') return;
      events.push({
        kind: 'response',
        payload: { responseId: await responseIdAt(sessionId, held.offset), promptId: held.promptId, text },
        createdAt: held.createdAt,
        offset: held.offset,
      });
    };

    for (const { value, offset } of lines) {
      const type = str(value.type);
      if (type !== 'user' && type !== 'assistant') continue;
      const message = isBlock(value.message) ? value.message : undefined;
      const text = textOf(message?.content);
      if (text.trim() === '') continue;
      const createdAt = lineTime(value, now);

      if (type === 'user') {
        await flushReply();
        promptId = await promptIdAt(sessionId, offset);
        events.push({ kind: 'prompt', payload: { promptId, text, origin: 'user', promptKind: 'user_query' }, createdAt, offset });
        continue;
      }
      if (reply === null) reply = { text: [], offset, createdAt, promptId };
      reply.text.push(text);
    }

    await flushReply();
    return events.sort((a, b) => a.offset - b.offset);
  },
};
