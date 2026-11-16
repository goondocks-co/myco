import { RecordSourceInvalid } from '@goondocks/myco-shared/record-identity';
import type { PromptIdRequest } from '@goondocks/myco-shared/prompt-identity';
import type { SymbiontAdapter, TranscriptTurn } from './adapter.js';
import { PROMPT_PREVIEW_CHARS } from '../constants.js';
import { findTranscriptFor } from './transcript-discovery.js';

/** GitHub Copilot CLI chronological event-log JSONL adapter. */

export const copilotAdapter: SymbiontAdapter = {
  name: 'copilot',
  displayName: 'GitHub Copilot',
  pluginRootEnvVar: 'COPILOT_PLUGIN_ROOT',
  hookFields: {
    sessionId: ['session_id', 'sessionId'],
    transcriptPath: ['transcript_path', 'transcriptPath'],
    lastResponse: ['last_assistant_message', 'response'],
    prompt: 'prompt',
    toolName: ['tool_name', 'toolName'],
    toolInput: ['tool_input', 'toolArgs'],
    toolOutput: ['tool_result', 'tool_response', 'toolResult'],
  },

  findTranscript: (sessionId) => findTranscriptFor('copilot', sessionId),

  parseTurns: (content) => parseCopilotEventLog(content),
  promptForTool: copilotPromptForTool,
};

const COPILOT_EVENT_TYPES = {
  USER_MESSAGE: 'user.message',
  ASSISTANT_MESSAGE: 'assistant.message',
  TOOL_EXECUTION_START: 'tool.execution_start',
} as const;

const COPILOT_USER_MESSAGE_SOURCE_FIELD = 'source';

/**
 * Parse Copilot's chronological event-log JSONL transcript and emit
 * one TranscriptTurn per user message.
 */
function parseCopilotEventLog(content: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: { prompt: string; timestamp: string; toolCount: number; aiResponse: string } | null = null;

  const flush = () => {
    if (!current) return;
    const promptText = current.prompt.trim();
    if (promptText) {
      const aiResponse = current.aiResponse.trim();
      turns.push({
        prompt: promptText.slice(0, PROMPT_PREVIEW_CHARS),
        toolCount: current.toolCount,
        timestamp: current.timestamp,
        ...(aiResponse ? { aiResponse } : {}),
      });
    }
    current = null;
  };

  for (const { event } of copilotEvents(content)) {
    const data = event.data ?? {};
    switch (event.type) {
      case COPILOT_EVENT_TYPES.USER_MESSAGE: {
        if (isSourcedUserMessage(data)) break;
        flush();
        const promptText = typeof data.content === 'string' ? data.content : '';
        current = {
          prompt: promptText,
          timestamp: event.timestamp ?? '',
          toolCount: 0,
          aiResponse: '',
        };
        break;
      }
      case COPILOT_EVENT_TYPES.ASSISTANT_MESSAGE: {
        if (!current) break;
        const text = typeof data.content === 'string' ? data.content.trim() : '';
        if (text) {
          current.aiResponse += current.aiResponse ? '\n' : '';
          current.aiResponse += text;
        }
        break;
      }
      case COPILOT_EVENT_TYPES.TOOL_EXECUTION_START: {
        if (current) current.toolCount += 1;
        break;
      }
      default:
        // session.start / assistant.turn_start / turn_end / tool.execution_complete — ignored
        break;
    }
  }

  flush();
  return turns;
}

function isSourcedUserMessage(data: CopilotEventData): boolean {
  return data[COPILOT_USER_MESSAGE_SOURCE_FIELD] !== undefined;
}

// --- Types ---

interface CopilotEvent {
  id?: string;
  parentId?: string;
  timestamp?: string;
  type: string;
  data?: CopilotEventData;
}

interface CopilotEventData {
  content?: unknown;
  [key: string]: unknown;
}

/** Decoded native events retain their byte coordinate. */
function* copilotEvents(content: string): Generator<{ event: CopilotEvent; offset: number }> {
  let offset = 0;
  for (const line of content.split('\n')) {
    const at = offset;
    offset += Buffer.byteLength(line) + 1;
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (event !== null && typeof event === 'object' && !Array.isArray(event)) yield { event: event as CopilotEvent, offset: at };
  }
}

/** A tool hook names its prompt through the assistant request's originatingMessageId. */
function copilotPromptForTool(content: string, input: { sessionId: string; raw: Record<string, unknown> }): PromptIdRequest | undefined {
  const toolKey = input.raw.toolCallId ?? input.raw.tool_call_id;
  if (typeof toolKey !== 'string' || toolKey === '') return undefined;
  const messages = new Map<string, number>();
  let origin: string | undefined;
  for (const { event, offset } of copilotEvents(content)) {
    const data = event.data ?? {};
    if (event.type === COPILOT_EVENT_TYPES.USER_MESSAGE && !isSourcedUserMessage(data)
      && typeof data.content === 'string' && data.content.trim() !== '' && typeof data.messageId === 'string') {
      messages.set(data.messageId, offset);
    }
    if (event.type !== COPILOT_EVENT_TYPES.ASSISTANT_MESSAGE || !Array.isArray(data.toolRequests)
      || !data.toolRequests.some(call => call !== null && typeof call === 'object' && call.toolCallId === toolKey)) continue;
    if (typeof data.originatingMessageId !== 'string' || data.originatingMessageId === '') continue;
    if (origin !== undefined && origin !== data.originatingMessageId) throw new RecordSourceInvalid();
    origin = data.originatingMessageId;
  }
  const position = origin === undefined ? undefined : messages.get(origin);
  return origin === undefined || position === undefined ? undefined : {
    scheme: 'member-transcript-v1', sessionId: input.sessionId, dedupeKey: origin, position,
  };
}
