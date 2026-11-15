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
    toolOutput: ['tool_response', 'toolResult'],
  },

  findTranscript: (sessionId) => findTranscriptFor('copilot', sessionId),

  parseTurns: (content) => parseCopilotEventLog(content),
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

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let event: CopilotEvent;
    try {
      event = JSON.parse(line) as CopilotEvent;
    } catch {
      continue; // skip malformed lines rather than abort the whole parse
    }
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
