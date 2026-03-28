import type { SymbiontAdapter } from './adapter.js';
import { findJsonlInSubdirs, parseJsonlTurns } from './adapter.js';
import path from 'node:path';
import os from 'node:os';

const TRANSCRIPT_BASE = path.join(os.homedir(), '.codex');

export const codexAdapter: SymbiontAdapter = {
  name: 'codex',
  displayName: 'Codex',
  pluginRootEnvVar: 'CODEX_PLUGIN_ROOT',
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

  // Codex uses 'role' field (like Cursor), not 'type' (like Claude Code)
  parseTurns: (content) => parseJsonlTurns(content, {
    roleField: 'role',
    extractTimestamp: false,
    skipToolResultUsers: false,
    stripImageTextRefs: false,
  }),
};
