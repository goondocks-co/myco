/**
 * Pi's own transcript.
 *
 * Pi writes an append-only JSONL per session, so unlike OpenCode and Cline it
 * needs no transcript written for it — the store stays Pi's and the member
 * only reads it. The format is Pi's rather than Myco's: a record type this
 * parser does not know is normal and is skipped.
 *
 * Every conversational record is `{type:'message', message:{role, content}}`
 * with the turn nested one level down, and `role` is `user`, `assistant` or
 * `toolResult`. A tool call is an `assistant` content block that the
 * `toolResult` message naming its id closes, so the pair is joined the way
 * Claude Code's is.
 *
 * Pi's records carry no prompt id, so one is derived positionally under this
 * agent's own namespace, as Cursor and Codex do. The member ships no `prompt`
 * for Pi, so there is no second id to agree with.
 */
import {
  callForResult, recordId, recordSource, optionalRecordSource, legacyRecordId, promptIdAtOffset, parserContinuation, blocksOf, isBlock, lineTime, plansInText, str, textOf, TOOL_OUTPUT_PREVIEW_CHARS,
  type DerivedEvent, type ParsedLine, type ParserInput, type TranscriptParser,
} from './index.js';

const promptIdAt = (sessionId: string, offset: number): Promise<string> => promptIdAtOffset('pi-prompt', sessionId, offset);

/** Context messages this extension delivers; never a turn of the conversation. */
const MYCO_CUSTOM_TYPES = new Set(['myco-context', 'myco-prompt-context']);

/** A tool call an assistant turn opened, held until the result naming it arrives. */


interface PiMessage {
  role?: unknown;
  content?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
}

function argumentsOf(value: unknown): Record<string, unknown> {
  if (isBlock(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isBlock(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // A non-JSON argument string is kept whole rather than dropped.
    }
    return { arguments: value };
  }
  return {};
}

export const piParser: TranscriptParser = {
  agent: 'pi',
  fidelity: 'full',
  schemes: ['offset-v1'],
  planTags: [],

  async parse(input: ParserInput): Promise<DerivedEvent[]> {
    const events: DerivedEvent[] = [];
    const continuation = parserContinuation(input);
    const pending = continuation.pending;
    let promptId = input.openPromptId;
    let planPosition = continuation.position;

    for (const { value, offset, undatedAt } of input.lines as readonly ParsedLine[]) {
      const createdAt = lineTime({ timestamp: value.timestamp }, input.now, undatedAt);
      const type = str(value.type);

      if (type === 'custom_message' && MYCO_CUSTOM_TYPES.has(String(value.customType))) continue;
      if (type !== 'message' || !isBlock(value.message)) continue;

      const message = value.message as PiMessage;
      const role = str(message.role);

      if (role === 'user') {
        const text = textOf(message.content);
        if (text.trim() === '') continue;
        promptId = await promptIdAt(input.sessionId, offset);
        events.push({
          kind: 'prompt',
          payload: { promptId, text, origin: 'user', promptKind: 'user_prompt' },
          createdAt,
          offset,
        });
        continue;
      }

      if (role === 'assistant') {
        // `thinking` blocks are the model's own working and are not the reply.
        const text = textOf(message.content);
        if (text.trim() !== '') {
          events.push({
            kind: 'response',
            source: recordSource(input, this.agent, { kind: 'response', record: value, block: 0 }),
            payload: { promptId, text },
            createdAt,
            offset,
          });
          const plans = await plansInText(text, this.planTags, input, this.agent, value, { promptId, offset, createdAt }, planPosition);
          events.push(...plans.events);
          planPosition = plans.next;
        }
        for (const block of blocksOf(message.content)) {
          if (block.type !== 'toolCall') continue;
          const name = str(block.name);
          if (name === undefined) continue;
          const source = optionalRecordSource(input, this.agent, { kind: 'tool-call', record: value, call: block, role: 'call' });
          if (source === undefined) continue;
          if (!('key' in source)) throw new Error('Tool invocation has no declared key');
          const callId = source.key;
          pending.set(callId, {
            toolCallId: await recordId(input, this.agent, { kind: 'tool-call', source, offset }),
            toolName: name.slice(0, 64),
            input: argumentsOf(block.arguments),
            createdAt,
            offset,
            promptId,
          });
        }
        continue;
      }

      if (role === 'toolResult') {
        const source = recordSource(input, this.agent, { kind: 'tool-call', record: value, result: value.message, role: 'result' });
        const call = 'key' in source ? await callForResult(input, this.agent, source, pending, { promptId, createdAt, offset }) : undefined;
        const name = str(message.toolName) ?? call?.toolName;
        if (name === undefined) continue;
        const failed = message.isError === true;
        const output = textOf(message.content).slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
        events.push({
          kind: failed ? 'tool.failure' : 'tool.use', source,
          legacyId: await legacyRecordId(input, { kind: 'tool-call', source, offset }),
          payload: {
            toolCallId: call?.toolCallId ?? await recordId(input, this.agent, { kind: 'tool-call', source, offset }),
            promptId: call?.promptId ?? promptId,
            toolName: name.slice(0, 64),
            input: call?.input ?? {},
            output: output === '' ? undefined : output,
            success: !failed,
            ...(failed ? { errorMessage: output === '' ? 'tool call failed' : output } : {}),
          },
          createdAt,
          offset,
        });
      }
      // `session`, `session_info`, `model_change`, `thinking_level_change` and
      // `compaction` carry settings or lifecycle rather than conversation.
      // `session` also carries the working directory attribution reads.
    }


    continuation.save(planPosition);
    return events;
  },
};
