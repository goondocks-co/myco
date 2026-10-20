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
 *
 * A prompt's id follows the transcript's pinned scheme. Under `offset-v1` it is
 * the user message's byte position. Under `codex-turn-v1` it is its place in
 * its turn: a `turn_context` or `task_started` record names the turn
 * (`payload.turn_id`, the prompt hook's `turn_id`), the turn's first message the
 * capture rules keep as a person's prompt is its opener, named by the turn
 * alone, and every other kept user message of the turn is named by its
 * acceptance order (the line's `metadata.user_input_order`, one counter for the
 * whole session) or, where the rollout records none, its byte position. A
 * message outside any turn the window has read names no prompt.
 */
import { sha256Hex, uuidv5 } from '../../hash.js';
import { evaluatePromptRules } from '@goondocks/myco-shared/capture-rules';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { canonicalPromptId, promptKeyHash, type PromptIdScheme, type TurnSubmission } from '@goondocks/myco-shared/prompt-identity';
import {
  callForResult, promptIdAtOffset, parserContinuation, blocksOf, isBlock, lineTime, plansInText, str, TOOL_OUTPUT_PREVIEW_CHARS,
  type DerivedEvent, type ParsedLine, type ParserInput, type ParserState, type ReplyPart, type TranscriptParser,
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

const promptIdAt = (sessionId: string, offset: number): Promise<string> => promptIdAtOffset('codex-prompt', sessionId, offset);
const responseIdAt = (sessionId: string, offset: number): Promise<string> => uuidv5('response', sessionId, String(offset));
const toolCallIdFor = (sessionId: string, callId: string): Promise<string> => uuidv5('tool-call', sessionId, callId);

/** The turn a `turn_context` or `task_started` record opens, or undefined for any other line. */
function turnOpened(value: Record<string, unknown>): string | undefined {
  if (!isBlock(value.payload)) return undefined;
  if (str(value.type) === 'turn_context') return str(value.payload.turn_id);
  if (str(value.type) === 'event_msg' && str(value.payload.type) === 'task_started') return str(value.payload.turn_id);
  return undefined;
}

/** A user message's acceptance order in its session, where the rollout records one. */
function acceptanceOrder(value: Record<string, unknown>): number | undefined {
  const order = isBlock(value.metadata) ? value.metadata.user_input_order : undefined;
  return typeof order === 'number' && Number.isSafeInteger(order) && order >= 0 ? order : undefined;
}

/** A kept user message's place in its turn under `codex-turn-v1`, moving the turn's opener once it is taken. */
function submissionIn(turn: NonNullable<ParserState['turn']>, human: boolean, order: number | undefined, offset: number): TurnSubmission {
  if (human && !turn.opened) {
    turn.opened = true;
    return { opener: true };
  }
  return order === undefined ? { offset } : { order };
}

async function promptIdUnder(scheme: PromptIdScheme, sessionId: string, offset: number, turn: () => { turnId: string; submission: TurnSubmission }): Promise<string> {
  if (scheme === 'offset-v1') return promptIdAt(sessionId, offset);
  if (scheme !== 'codex-turn-v1') throw new Error(`the Codex parser derives no prompt id under ${scheme}`);
  return canonicalPromptId(uuidv5, { scheme, sessionId, ...turn() });
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
  schemes: ['offset-v1', 'codex-turn-v1'],
  planTags: ['proposed_plan'],
  headerContext: codexHeaderContext,

  async parse(input: ParserInput): Promise<DerivedEvent[]> {
    const { lines, sessionId, now, openPromptId, transcriptMeta, scheme } = input;
    const events: DerivedEvent[] = [];
    const held: ParserState = input.state ?? {};
    const continuation = parserContinuation(input);
    const pending = continuation.pending;
    let promptId: string | undefined = openPromptId;
    let reply: { parts: ReplyPart[]; promptId?: string } | null = null;
    let planPosition = continuation.position;
    const metadata = transcriptMeta ?? codexHeaderContext(lines);

    const flushReply = async (): Promise<void> => {
      if (reply === null) return;
      const held = reply;
      reply = null;
      for (const chunk of held.parts) {
        events.push({
          kind: 'response',
          payload: { responseId: await responseIdAt(sessionId, chunk.offset), promptId: held.promptId, text: chunk.text },
          createdAt: chunk.createdAt,
          offset: chunk.offset,
        });
      }
    };

    for (const { value, offset, undatedAt } of lines) {
      const opened = scheme === 'codex-turn-v1' ? turnOpened(value) : undefined;
      if (opened !== undefined && held.turn?.id !== opened) held.turn = { id: opened, opened: false };
      if (str(value.type) !== 'response_item' || !isBlock(value.payload)) continue;
      const payload = value.payload;
      const createdAt = lineTime(value, now, undatedAt);
      const kind = str(payload.type);

      if (kind === 'message') {
        const text = codexText(payload.content);
        if (text.trim() === '') continue;
        if (str(payload.role) === 'user') {
          await flushReply();
          // A turn-keyed message outside any turn the window has read names no prompt: only a reread starting past a
          // pruned prefix reads one, and the rows the first read named stand.
          if (scheme === 'codex-turn-v1' && held.turn === undefined) continue;
          const decision = evaluatePromptRules(CAPTURE_RULE_BUNDLES, 'codex', { prompt: text, transcriptPath: sessionId, transcriptMeta: metadata, record: value });
          if (decision.action === 'drop') continue;
          const opensTurn = decision.origin === undefined || decision.origin === 'human';
          const capturedPromptId = await promptIdUnder(scheme, sessionId, offset,
            () => ({ turnId: held.turn!.id, submission: submissionIn(held.turn!, opensTurn, acceptanceOrder(value), offset) }));
          if (opensTurn) {
            promptId = capturedPromptId;
          }
          events.push({ kind: 'prompt', payload: { promptId: capturedPromptId, text: decision.prompt, origin: opensTurn ? 'user' : decision.origin, promptKind: 'message',
            ...(scheme === 'codex-turn-v1' ? { promptKeyHash: await promptKeyHash(sha256Hex, decision.prompt) } : {}) }, createdAt, offset, opensTurn });
          continue;
        }
        if (str(payload.role) !== 'assistant') continue;
        if (reply === null) reply = { parts: [], promptId };
        reply.parts.push({ text, offset, createdAt });
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
        if (callId === undefined) continue;
        const call = await callForResult(sessionId, callId, pending, { promptId, createdAt, offset });
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
          offset: input.state === undefined ? call.offset : offset,
        });
      }
    }

    await flushReply();

    continuation.save(planPosition);
    return events.sort((a, b) => a.offset - b.offset);
  },
};
