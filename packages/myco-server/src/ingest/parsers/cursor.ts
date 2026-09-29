/**
 * Cursor's agent transcript, as both `cursor-agent` and the IDE's agent write
 * it under `~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl`:
 * one JSON object per line, `role` naming the speaker and the words at
 * `message.content` as an array of typed blocks (`text`, `tool_use`). A turn
 * closes with `{"type":"turn_ended"}`. Lines carry no timestamp.
 *
 * A person's words arrive wrapped: `<user_query>` holds what they typed, beside
 * blocks the agent adds (`<timestamp>`, `<image_files>`, `<attached_files>`).
 * A user line that is nothing but such a block (`<git_status>`, the subagent
 * catalogue) is context the agent injected, not a prompt. Cursor masks its
 * reasoning in assistant text with a literal `[REDACTED]`, which is dropped.
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

/** The line that closes a turn. */
const TURN_ENDED = 'turn_ended';

/**
 * What the person typed: the `<user_query>` block when the line carries one,
 * else the text left once every wrapped block is removed — nothing, for a line
 * that is only injected context.
 */
export function promptTextOf(text: string): string {
  const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
  if (query !== null) return query[1].trim();
  return text.replace(/<([a-z_]+)>[\s\S]*?<\/\1>/g, '').trim();
}

/** Assistant text with Cursor's `[REDACTED]` reasoning masks removed. */
export function responseTextOf(text: string): string {
  return text
    .replace(/(^|\n)\s*\[REDACTED\]\s*(?=\n|$)/g, '$1')
    .replace(/\s*\[REDACTED\]\s*$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const cursorParser: TranscriptParser = {
  agent: 'cursor',
  fidelity: 'no_tool_results',
  planTags: [],

  async parse({ lines, sessionId, now, openPromptId }: ParserInput): Promise<DerivedEvent[]> {
    const events: DerivedEvent[] = [];
    let promptId: string | undefined = openPromptId;
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

    for (const { value, offset, undatedAt } of lines) {
      if (str(value.type) === TURN_ENDED) {
        await flushReply();
        continue;
      }
      const role = str(value.role);
      if (role !== 'user' && role !== 'assistant') continue;
      const message = isBlock(value.message) ? value.message : undefined;
      const raw = textOf(message?.content);
      const text = role === 'user' ? promptTextOf(raw) : responseTextOf(raw);
      if (text === '') continue;
      const createdAt = lineTime(value, now, undatedAt);

      if (role === 'user') {
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
