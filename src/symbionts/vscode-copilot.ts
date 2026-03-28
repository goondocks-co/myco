import type { SymbiontAdapter } from './adapter.js';
import { parseJsonlTurns } from './adapter.js';

export const vscodeCopilotAdapter: SymbiontAdapter = {
  name: 'vscode-copilot',
  displayName: 'VS Code Copilot',
  pluginRootEnvVar: 'VSCODE_PLUGIN_ROOT',
  hookFields: {
    sessionId: 'sessionId',
    transcriptPath: 'transcript_path',
    lastResponse: 'last_assistant_message',
    prompt: 'prompt',
    toolName: 'tool_name',
    toolInput: 'tool_input',
    toolOutput: 'tool_output',
  },

  // VS Code doesn't have a known transcript directory — hooks provide the path
  findTranscript: () => null,

  // Try Claude Code format first (type field), then Cursor format (role field)
  parseTurns: (content) => {
    const claudeResult = parseJsonlTurns(content, {
      roleField: 'type',
      extractTimestamp: true,
      skipToolResultUsers: true,
      stripImageTextRefs: false,
    });
    if (claudeResult.length > 0) return claudeResult;

    return parseJsonlTurns(content, {
      roleField: 'role',
      extractTimestamp: false,
      skipToolResultUsers: false,
      stripImageTextRefs: false,
    });
  },
};
