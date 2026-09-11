/**
 * Codex's rollout file: one JSON object per line, wrapping a `response_item`.
 *
 *   payload.type = 'message'        role `user` carries `input_text` blocks,
 *                                   role `assistant` carries `output_text`.
 *   payload.type = 'function_call' or 'custom_tool_call': `call_id` links
 *                  the call to its corresponding output item.
 *
 * `session_meta` supplies capture-rule context. Developer and system messages
 * carry no response row. Assistant `proposed_plan` envelopes produce plans.
 */
import { uuidv5 } from '../../hash.js';
import { evaluatePromptRules } from '@goondocks/myco-shared/capture-rules';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import {
  blocksOf, isBlock, lineTime, plansInText, str, TOOL_OUTPUT_PREVIEW_CHARS,
  type DerivedEvent, type ParsedLine, type ParserInput, type TranscriptParser,
} from './index.js';

const TOOL_NAME_CHARS = 64;

function codexHeaderContext(lines: readonly ParsedLine[]): Record<string, unknown> {
  const header = lines.find(({ value }) => value.type === 'session_meta')?.value.payload;
  return isBlock(header) ? header : {};
}

/** The text of a Codex content array: the block types that carry words. */
function codexText(content: unknown): string {
  return blocksOf(content)
    .filter((b) => b.type === 'input_text' || b.type === 'output_text' || b.type === 'text')
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .filter((t) => t !== '')
    .join('\n\n');
}

const promptIdAt = (sessionId: string, offset: number): Promise<string> => uuidv5('codex-prompt', sessionId, String(offset));
const responseIdAt = (sessionId: string, offset: number): Promise<string> => uuidv5('response', sessionId, String(offset));
const toolCallIdFor = (sessionId: string, callId: string): Promise<string> => uuidv5('tool-call', sessionId, callId);

interface PendingCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  promptId?: string;
  createdAt: number;
  offset: number;
}

/** A function call's arguments, which Codex ships as a JSON string. */
function argumentsOf(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { arguments: raw };
  }
}

export const codexParser: TranscriptParser = {
  agent: 'codex',
  // This parser reads function and custom calls with string or content-array outputs.
  // Other tool-call shapes require the member's PostToolUse capture.
  fidelity: 'no_tool_results',
  planTags: ['proposed_plan'],
  headerContext: codexHeaderContext,

  async parse({ lines, sessionId, now, openPromptId, transcriptMeta }: ParserInput): Promise<DerivedEvent[]> {
    const events: DerivedEvent[] = [];
    const pending = new Map<string, PendingCall>();
    let promptId: string | undefined = openPromptId;
    let reply: { text: string[]; offset: number; createdAt: number; promptId?: string } | null = null;
    let planPosition = 0;
    const metadata = transcriptMeta ?? codexHeaderContext(lines);

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
      if (str(value.type) !== 'response_item' || !isBlock(value.payload)) continue;
      const payload = value.payload;
      const createdAt = lineTime(value, now);
      const kind = str(payload.type);

      if (kind === 'message') {
        const text = codexText(payload.content);
        if (text.trim() === '') continue;
        if (str(payload.role) === 'user') {
          await flushReply();
          const decision = evaluatePromptRules(CAPTURE_RULE_BUNDLES, 'codex', { prompt: text, transcriptPath: sessionId, transcriptMeta: metadata, record: value });
          if (decision.action === 'drop') continue;
          const opensTurn = decision.origin === undefined || decision.origin === 'human';
          const capturedPromptId = await promptIdAt(sessionId, offset);
          if (opensTurn) {
            promptId = capturedPromptId;
          }
          events.push({ kind: 'prompt', payload: { promptId: capturedPromptId, text: decision.prompt, origin: opensTurn ? 'user' : decision.origin, promptKind: 'message' }, createdAt, offset, opensTurn });
          continue;
        }
        if (str(payload.role) !== 'assistant') continue;
        if (reply === null) reply = { text: [], offset, createdAt, promptId };
        reply.text.push(text);
        const plans = await plansInText(text, codexParser.planTags, sessionId, { promptId, offset, createdAt }, planPosition);
        events.push(...plans.events);
        planPosition = plans.next;
        continue;
      }

      if (kind === 'function_call' || kind === 'custom_tool_call') {
        const callId = str(payload.call_id) ?? str(payload.id);
        const name = str(payload.name);
        if (callId === undefined || name === undefined) continue;
        pending.set(callId, {
          toolCallId: await toolCallIdFor(sessionId, callId),
          toolName: name.slice(0, TOOL_NAME_CHARS),
          input: kind === 'function_call' ? argumentsOf(payload.arguments) : payload.input,
          promptId,
          createdAt,
          offset,
        });
        continue;
      }

      if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
        const callId = str(payload.call_id);
        const call = callId === undefined ? undefined : pending.get(callId);
        if (call === undefined || callId === undefined) continue;
        pending.delete(callId);
        const output = (typeof payload.output === 'string' ? payload.output : codexText(payload.output)).slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
        const failed = payload.success === false;
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
    }

    await flushReply();

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
