/**
 * Pi's own transcript.
 *
 * Pi writes an append-only JSONL per session, so unlike OpenCode and Cline it
 * needs no transcript written for it — the store stays Pi's and the member
 * only reads it. That also means the format is Pi's rather than Myco's: a
 * record type this parser does not know is normal and is skipped.
 *
 * Pi's records carry no prompt id, so one is derived positionally under this
 * agent's own namespace, as Cursor and Codex do. The member ships no `prompt`
 * for Pi, so there is no second id to agree with.
 */
import { uuidv5 } from '../../hash.js';
import {
  isBlock, lineTime, offsetIdFor, plansInText, str, textOf, TOOL_OUTPUT_PREVIEW_CHARS,
  type DerivedEvent, type ParserInput, type TranscriptParser,
} from './index.js';

const promptIdAt = (sessionId: string, offset: number): Promise<string> => uuidv5('pi-prompt', sessionId, String(offset));

/** Pi's own context messages, which the Myco extension delivers; never a turn of the conversation. */
const MYCO_CUSTOM_TYPES = new Set(['myco-context', 'myco-prompt-context']);

interface PiLine {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  customType?: unknown;
  toolName?: unknown;
  input?: unknown;
  output?: unknown;
  isError?: unknown;
  timestamp?: unknown;
}

function toolInput(value: unknown): Record<string, unknown> | undefined {
  return isBlock(value) ? (value as Record<string, unknown>) : undefined;
}

export const piParser: TranscriptParser = {
  agent: 'pi',
  fidelity: 'full',
  planTags: [],

  async parse(input: ParserInput): Promise<DerivedEvent[]> {
    const events: DerivedEvent[] = [];
    let promptId = input.openPromptId;
    let planPosition = 0;

    for (const { value, offset } of input.lines) {
      const line = value as PiLine;
      const createdAt = lineTime({ timestamp: line.timestamp }, input.now);
      const type = str(line.type);

      // A context message this extension delivered is not a turn.
      if (type === 'custom_message' && MYCO_CUSTOM_TYPES.has(String(line.customType))) continue;

      if (type === 'message' && line.role === 'user') {
        const text = textOf(line.content);
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

      if (type === 'message' && line.role === 'assistant') {
        const text = textOf(line.content);
        if (text.trim() === '') continue;
        events.push({
          kind: 'response',
          payload: { responseId: await offsetIdFor('response', input.sessionId, offset), promptId, text },
          createdAt,
          offset,
        });
        const plans = await plansInText(text, this.planTags, input.sessionId, { promptId, offset, createdAt }, planPosition);
        events.push(...plans.events);
        planPosition = plans.next;
        continue;
      }

      if (type === 'tool_result') {
        const name = str(line.toolName);
        if (name === undefined) continue;
        const failed = line.isError === true;
        const output = typeof line.output === 'string' ? line.output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) : undefined;
        events.push({
          kind: failed ? 'tool.failure' : 'tool.use',
          payload: {
            toolCallId: await offsetIdFor('tool-call', input.sessionId, offset),
            promptId,
            toolName: name.slice(0, 64),
            input: toolInput(line.input) ?? {},
            output,
            success: !failed,
            ...(failed ? { errorMessage: output ?? 'tool call failed' } : {}),
          },
          createdAt,
          offset,
        });
      }
      // `session`, `model_change` and `thinking_level_change` carry settings
      // rather than conversation. `session` also carries the working directory
      // attribution reads from the head of the file.
    }

    return events;
  },
};
