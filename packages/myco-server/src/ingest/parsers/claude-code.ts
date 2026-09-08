/**
 * Claude Code's transcript: one JSON object per line, `type` naming the record.
 *
 * The shapes this reads, and the rule each carries:
 *
 *   user       a prompt when it declares `promptId` and is not `isMeta`; the
 *              same record shape also carries tool RESULTS, which name no
 *              prompt and must never become one.
 *   attachment a queued command — text at `attachment.prompt`, deduped on the
 *              record's own `uuid`.
 *   assistant  `message.content` blocks: `text` is the reply, `tool_use` is a
 *              call awaiting its result, `image` is an attachment.
 *
 * A turn is a prompt and everything until the next prompt. The reply is the
 * turn's assistant text joined and emitted once. The member also emits one
 * response per Stop rather than one per assistant record, so one row per turn
 * holds on both paths and the two remain comparable.
 *
 * A `tool_use` is held until the `tool_result` naming it arrives, so success
 * and output land on the same row as the call. A call the transcript never
 * answers is still a call the transcript records, and it is emitted at the end
 * as an unfinished one rather than dropped.
 */
import { uuidv5 } from '../../hash.js';
import {
  blocksOf, isBlock, lineTime, planKeyForTag, promptIdFor, str, textOf, TOOL_OUTPUT_PREVIEW_CHARS,
  type DerivedEvent, type ParserInput, type TranscriptParser,
} from './index.js';

/** The assistant text wrappers a plan is carried in; the member scans the same tags. */
export const PLAN_TAGS = ['plan', 'myco-plan'] as const;

/** A plan-tag envelope's body, non-greedy so consecutive envelopes stay separate. */
export const planEnvelope = (tag: string): RegExp => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');

/** The longest tool name the catalogue admits. */
const TOOL_NAME_CHARS = 64;

/** The first Markdown heading of a body, for a plan the transcript gives no title. */
export function firstHeading(content: string): string | undefined {
  for (const line of content.split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].slice(0, 256);
  }
  return undefined;
}

/** A tool call's row id. The member mints a random one per hook (`envelope.ts:229`), so this derivation is the parse's own; the parity gate compares the two by content and excludes the id by name. */
const toolCallIdFor = (sessionId: string, toolUseId: string): Promise<string> => uuidv5('tool-call', sessionId, toolUseId);
/** A response's row id, keyed by the turn's first assistant byte; the member mints a random one at Stop. */
const responseIdFor = (sessionId: string, offset: number): Promise<string> => uuidv5('response', sessionId, String(offset));

interface PendingCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  promptId?: string;
  createdAt: number;
  offset: number;
}

/** A user record that names a prompt, rather than one carrying a tool result. */
const namesPrompt = (v: Record<string, unknown>): boolean =>
  v.isMeta !== true
  && str(v.promptId) !== undefined
  && blocksOf((v.message as Record<string, unknown> | undefined)?.content).every((b) => b.type !== 'tool_result');

export const claudeCodeParser: TranscriptParser = {
  agent: 'claude-code',
  fidelity: 'full',

  async parse({ lines, sessionId, now }: ParserInput): Promise<DerivedEvent[]> {
    const events: DerivedEvent[] = [];
    const pending = new Map<string, PendingCall>();
    let promptId: string | undefined;
    let reply: { text: string[]; offset: number; createdAt: number; promptId?: string } | null = null;
    let planPosition = 0;

    const flushReply = async (): Promise<void> => {
      if (reply === null) return;
      const held = reply;
      reply = null;
      const text = held.text.join('\n\n').trim();
      if (text === '') return;
      events.push({
        kind: 'response',
        payload: { responseId: await responseIdFor(sessionId, held.offset), promptId: held.promptId, text },
        createdAt: held.createdAt,
        offset: held.offset,
      });
    };

    for (const { value, offset } of lines) {
      const createdAt = lineTime(value, now);
      const type = str(value.type);
      const message = isBlock(value.message) ? value.message : undefined;

      if (type === 'user' && namesPrompt(value)) {
        await flushReply();
        const text = textOf(message?.content);
        if (text.trim() !== '') {
          promptId = await promptIdFor(sessionId, str(value.promptId)!);
          events.push({ kind: 'prompt', payload: { promptId, text, origin: 'user', promptKind: 'user_prompt' }, createdAt, offset });
        }
        continue;
      }

      if (type === 'attachment' && isBlock(value.attachment) && str(value.attachment.type) === 'queued_command') {
        await flushReply();
        const text = textOf(value.attachment.prompt);
        const key = str(value.uuid);
        if (text.trim() !== '' && key !== undefined) {
          promptId = await promptIdFor(sessionId, key);
          events.push({ kind: 'prompt', payload: { promptId, text, origin: 'user', promptKind: 'queued_command' }, createdAt, offset });
        }
        continue;
      }

      if (type === 'user') {
        // A tool result closes the call it names and is not a turn boundary.
        for (const block of blocksOf(message?.content)) {
          if (block.type !== 'tool_result') continue;
          const id = str(block.tool_use_id);
          const call = id === undefined ? undefined : pending.get(id);
          if (call === undefined || id === undefined) continue;
          pending.delete(id);
          const failed = block.is_error === true;
          const output = textOf(block.content).slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
          events.push({
            kind: failed ? 'tool.failure' : 'tool.use',
            payload: {
              toolCallId: call.toolCallId,
              promptId: call.promptId,
              toolName: call.toolName,
              input: call.input,
              ...(output === '' ? {} : { output }),
              success: !failed,
              ...(failed ? { errorMessage: output === '' ? 'tool failed' : output } : {}),
            },
            createdAt: call.createdAt,
            offset: call.offset,
          });
        }
        continue;
      }

      if (type !== 'assistant') continue;

      for (const block of blocksOf(message?.content)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (reply === null) reply = { text: [], offset, createdAt, promptId };
          reply.text.push(block.text);
          for (const tag of PLAN_TAGS) {
            const re = planEnvelope(tag);
            let match: RegExpExecArray | null;
            while ((match = re.exec(block.text)) !== null) {
              const content = match[1].trim();
              if (content === '') continue;
              events.push({
                kind: 'plan',
                payload: {
                  planKey: await planKeyForTag(sessionId, tag, planPosition),
                  promptId,
                  title: firstHeading(content),
                  content,
                  status: 'active',
                  originPath: `transcript:${tag}`,
                  tags: [tag],
                  source: 'tag',
                },
                createdAt,
                offset,
              });
              planPosition += 1;
            }
          }
          continue;
        }
        if (block.type === 'tool_use') {
          const id = str(block.id);
          const name = str(block.name);
          if (id === undefined || name === undefined) continue;
          pending.set(id, {
            toolCallId: await toolCallIdFor(sessionId, id),
            toolName: name.slice(0, TOOL_NAME_CHARS),
            input: block.input ?? {},
            promptId,
            createdAt,
            offset,
          });
        }
      }
    }

    await flushReply();

    // A call the transcript never answered still happened; the row records it
    // as unfinished rather than losing it.
    for (const call of pending.values()) {
      events.push({
        kind: 'tool.failure',
        payload: {
          toolCallId: call.toolCallId,
          promptId: call.promptId,
          toolName: call.toolName,
          input: call.input,
          success: false,
          errorMessage: 'tool call has no result in the transcript',
        },
        createdAt: call.createdAt,
        offset: call.offset,
      });
    }

    return events.sort((a, b) => a.offset - b.offset);
  },
};
