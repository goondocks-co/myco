import type { SymbiontAdapter } from './adapter.js';
import { findJsonlInSubdirs, parseJsonlTurns } from './adapter.js';
import path from 'node:path';
import os from 'node:os';

const TRANSCRIPT_BASE = path.join(os.homedir(), '.claude', 'projects');

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

  findTranscript: (sessionId) => findJsonlInSubdirs(TRANSCRIPT_BASE, sessionId),

  parseTurns: (content) => parseJsonlTurns(content, {
    roleField: 'type',
    extractTimestamp: true,
    skipToolResultUsers: true,
    stripImageTextRefs: true,
  }),
};
