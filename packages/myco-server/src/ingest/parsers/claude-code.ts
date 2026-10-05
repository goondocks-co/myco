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
 * A turn is a prompt and everything until the next prompt. The registry emits
 * joined replies at turn boundaries and retains unresolved tool calls until
 * a result or a declared terminal outcome.
 */
import { uuidv5 } from '../../hash.js';
import {
  callForResult, parserContinuation, blocksOf, isBlock, lineTime, ownedLines, plansInText, promptIdFor, str, textOf, TOOL_OUTPUT_PREVIEW_CHARS,
  type ReplyPart, type DerivedEvent, type ParserInput, type TranscriptParser,
} from './index.js';

/** The longest tool name the catalogue admits. */
const TOOL_NAME_CHARS = 64;

/** A tool call's row id. The member mints a random one per hook (`envelope.ts:229`), so this derivation is the parse's own; the parity gate compares the two by content and excludes the id by name. */
const toolCallIdFor = (sessionId: string, toolUseId: string): Promise<string> => uuidv5('tool-call', sessionId, toolUseId);
/** A response's row id, keyed by an assistant record's byte offset; the member mints a random one at Stop. */
const responseIdFor = (sessionId: string, offset: number): Promise<string> => uuidv5('response', sessionId, String(offset));



/** A user record that names a prompt, rather than one carrying a tool result. */
const namesPrompt = (v: Record<string, unknown>): boolean =>
  v.isMeta !== true
  && str(v.promptId) !== undefined
  && blocksOf((v.message as Record<string, unknown> | undefined)?.content).every((b) => b.type !== 'tool_result');

export const claudeCodeParser: TranscriptParser = {
  agent: 'claude-code',
  fidelity: 'full',
  planTags: ['ultraplan'],
  continuation: { parentSessionIdPath: 'session_id', markerPaths: ['isCompactSummary'] },

  async parse(input: ParserInput): Promise<DerivedEvent[]> {
    const { lines: all, sessionId, now, openPromptId } = input;
    const lines = ownedLines(all, sessionId, claudeCodeParser.continuation);
    const events: DerivedEvent[] = [];
    const continuation = parserContinuation(input);
    const pending = continuation.pending;
    let promptId: string | undefined = openPromptId;
    let reply: { parts: ReplyPart[]; promptId?: string } | null = null;
    let planPosition = continuation.position;

    const flushReply = async (): Promise<void> => {
      if (reply === null) return;
      const held = reply;
      reply = null;
      for (const chunk of held.parts) {
        events.push({
          kind: 'response',
          payload: { responseId: await responseIdFor(sessionId, chunk.offset), promptId: held.promptId, text: chunk.text },
          createdAt: chunk.createdAt,
          offset: chunk.offset,
        });
      }
    };

    for (const { value, offset, undatedAt } of lines) {
      const createdAt = lineTime(value, now, undatedAt);
      const type = str(value.type);
      const message = isBlock(value.message) ? value.message : undefined;

      if (type === 'user' && namesPrompt(value)) {
        await flushReply();
        const text = textOf(message?.content);
        if (text.trim() !== '') {
          promptId = await promptIdFor(sessionId, 'user_prompt', str(value.promptId)!);
          events.push({ kind: 'prompt', payload: { promptId, text, origin: 'user', promptKind: 'user_prompt' }, createdAt, offset });
        }
        continue;
      }

      if (type === 'attachment' && isBlock(value.attachment) && str(value.attachment.type) === 'queued_command') {
        await flushReply();
        const text = textOf(value.attachment.prompt);
        const key = str(value.uuid);
        if (text.trim() !== '' && key !== undefined) {
          promptId = await promptIdFor(sessionId, 'queued_command', key);
          events.push({ kind: 'prompt', payload: { promptId, text, origin: 'user', promptKind: 'queued_command' }, createdAt, offset });
        }
        continue;
      }

      if (type === 'user') {
        // A tool result closes the call it names and is not a turn boundary.
        for (const block of blocksOf(message?.content)) {
          if (block.type !== 'tool_result') continue;
          const id = str(block.tool_use_id);
          if (id === undefined) continue;
          const call = await callForResult(sessionId, id, pending, { promptId, createdAt, offset });
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
            offset: input.state === undefined ? call.offset : offset,
          });
        }
        continue;
      }

      if (type !== 'assistant') continue;

      for (const block of blocksOf(message?.content)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (reply === null) reply = { parts: [], promptId };
          reply.parts.push({ text: block.text, offset, createdAt });
          const plans = await plansInText(block.text, claudeCodeParser.planTags, sessionId, { promptId, offset, createdAt }, planPosition);
          events.push(...plans.events);
          planPosition = plans.next;
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


    continuation.save(planPosition);
    return events.sort((a, b) => a.offset - b.offset);
  },
};
