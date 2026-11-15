import type { SymbiontAdapter } from './adapter.js';
import { AntigravityJsonlParser } from './parsers/antigravity-jsonl.js';
import { findTranscriptFor } from './transcript-discovery.js';

/** Antigravity hooks carry conversationId and transcriptPath; prompts and replies are read from the transcript. */
const antigravityParser = new AntigravityJsonlParser();

export const antigravityAdapter: SymbiontAdapter = {
  name: 'antigravity',
  displayName: 'Google Antigravity',
  pluginRootEnvVar: 'ANTIGRAVITY_PLUGIN_ROOT',
  hookFields: {
    sessionId: 'conversationId',
    transcriptPath: 'transcriptPath',
    toolName: 'toolCall.name',
    toolInput: 'toolCall.args',
    toolError: 'error',
  },

  findTranscript: (conversationId) => findTranscriptFor('antigravity', conversationId),

  parseTurns: (content) => antigravityParser.parseTurns(content),
};
