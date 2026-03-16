import type { AgentAdapter } from './adapter.js';
import { findJsonlInSubdirs, parseJsonlTurns } from './adapter.js';
import path from 'node:path';
import os from 'node:os';

const TRANSCRIPT_BASE = path.join(os.homedir(), '.claude', 'projects');

export const claudeCodeAdapter: AgentAdapter = {
  name: 'claude-code',
  displayName: 'Claude Code',
  pluginRootEnvVar: 'CLAUDE_PLUGIN_ROOT',
  hookFields: {
    transcriptPath: 'transcript_path',
    lastResponse: 'last_assistant_message',
    sessionId: 'session_id',
  },

  findTranscript: (sessionId) => findJsonlInSubdirs(TRANSCRIPT_BASE, sessionId),

  parseTurns: (content) => parseJsonlTurns(content, {
    roleField: 'type',
    extractTimestamp: true,
    skipToolResultUsers: true,
    stripImageTextRefs: true,
  }),
};
