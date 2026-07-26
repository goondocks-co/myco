import type { SymbiontAdapter } from './adapter.js';
import { parseJsonlTurns } from './adapter.js';
import { findTranscriptFor } from './transcript-discovery.js';

export const claudeCodeAdapter: SymbiontAdapter = {
  name: 'claude-code',
  displayName: 'Claude Code',
  pluginRootEnvVar: 'CLAUDE_PLUGIN_ROOT',
  hookFields: {
    sessionId: 'session_id',
    transcriptPath: 'transcript_path',
    lastResponse: 'last_assistant_message',
    prompt: 'prompt',
    toolName: 'tool_name',
    toolInput: 'tool_input',
    toolOutput: 'tool_output',
  },

  findTranscript: (sessionId) => findTranscriptFor('claude-code', sessionId),

  parseTurns: (content) => parseJsonlTurns(content, {
    roleField: 'type',
    extractTimestamp: true,
    skipToolResultUsers: true,
    stripImageTextRefs: true,
  }),
};
