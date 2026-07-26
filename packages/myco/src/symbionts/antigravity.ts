import type { SymbiontAdapter } from './adapter.js';
import { AntigravityJsonlParser } from './parsers/antigravity-jsonl.js';
import { findTranscriptFor } from './transcript-discovery.js';

/**
 * Google Antigravity symbiont adapter.
 *
 * Plugin bundle root (shared across surfaces): `~/.gemini/config/plugins/<name>/`.
 * Hook contract: JSON stdin/stdout, camelCase fields (`conversationId`,
 * `transcriptPath`, `artifactDirectoryPath`).
 *
 * Conversations live under `~/.gemini/<surface>/brain/<conversationId>/`, with
 * the surface precedence and transcript leaf declared in the manifest's
 * `capture.transcriptDiscovery`.
 */

const antigravityParser = new AntigravityJsonlParser();

export const antigravityAdapter: SymbiontAdapter = {
  name: 'antigravity',
  displayName: 'Google Antigravity',
  pluginRootEnvVar: 'ANTIGRAVITY_PLUGIN_ROOT',
  hookFields: {
    sessionId: 'conversationId',
    transcriptPath: 'transcriptPath',
    lastResponse: 'last_assistant_message',
    prompt: 'prompt',
    toolName: 'toolCall.name',
    toolInput: 'toolCall.args',
    toolOutput: 'tool_output',
  },

  findTranscript: (conversationId) => findTranscriptFor('antigravity', conversationId),

  parseTurns: (content) => antigravityParser.parseTurns(content),
};
