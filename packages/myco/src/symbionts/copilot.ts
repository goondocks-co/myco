import type { SymbiontAdapter, TranscriptTurn } from './adapter.js';
import { PROMPT_PREVIEW_CHARS } from '../constants.js';

/**
 * GitHub Copilot — one symbiont covers two surfaces of the same agent
 * runtime: the terminal `copilot` CLI and the VS Code Copilot extension.
 * The VS Code extension drives the same agent through the Copilot SDK
 * (`code.visualstudio.com/blogs/2025/11/03/unified-agent-experience`).
 * Hooks, skills, and instructions are shared at `~/.copilot/`; MCP is
 * the one place the surfaces diverge — handled by the manifest's
 * multi-target `globalMcpTarget`.
 *
 * Transcript parsing targets the event-log JSONL format emitted by
 * `copilot-agent` v0.49+ (and the VS Code Copilot extension after the
 * `unified-agent-experience` rework). One JSON object per line, ordered
 * chronologically, every line shaped:
 *   { id, parentId, timestamp, type, data }
 *
 * Event types we care about:
 *   - `session.start`           one-time header; `data.sessionId`, version info
 *   - `user.message`            opens a new turn; `data.content` is the prompt
 *   - `assistant.message`       AI text; `data.content`, optional `data.toolRequests[]`
 *   - `tool.execution_start`    each invocation by the assistant; counted
 *   - `tool.execution_complete` we ignore (the start event is the authoritative count)
 *   - `assistant.turn_start`    boundary marker; ignored
 *   - `assistant.turn_end`      boundary marker; ignored
 *
 * Turn assembly: walk events in order. A `user.message` opens a turn;
 * subsequent `assistant.message.content` blocks accumulate as `aiResponse`;
 * subsequent `tool.execution_start` events increment `toolCount`. The next
 * `user.message` (or end of stream) flushes the open turn.
 */

export const copilotAdapter: SymbiontAdapter = {
  name: 'copilot',
  displayName: 'GitHub Copilot',
  pluginRootEnvVar: 'COPILOT_PLUGIN_ROOT',
  hookFields: {
    sessionId: 'sessionId',
    transcriptPath: 'transcript_path',
    lastResponse: 'last_assistant_message',
    prompt: 'prompt',
    toolName: 'tool_name',
    toolInput: 'tool_input',
    toolOutput: 'tool_output',
  },

  // Copilot (both surfaces) doesn't have a predictable transcript directory —
  // hooks provide the path via the payload's `transcript_path` field.
  findTranscript: () => null,

  parseTurns: (content) => parseCopilotEventLog(content),
};

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
      case 'user.message': {
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
      case 'assistant.message': {
        if (!current) break;
        const text = typeof data.content === 'string' ? data.content.trim() : '';
        if (text) {
          current.aiResponse += current.aiResponse ? '\n' : '';
          current.aiResponse += text;
        }
        break;
      }
      case 'tool.execution_start': {
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

// --- Types ---

interface CopilotEvent {
  id?: string;
  parentId?: string;
  timestamp?: string;
  type: string;
  data?: { content?: unknown; [key: string]: unknown };
}
