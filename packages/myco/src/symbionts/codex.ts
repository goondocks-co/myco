import type { SymbiontAdapter } from './adapter.js';
import { CodexJsonlParser } from './parsers/codex-jsonl.js';
import { systemEnvelopePrefixes, systemEnvelopeTags } from './envelope-prefixes.js';
import { findTranscriptFor } from './transcript-discovery.js';
// Envelope prefixes/tags come from the codex manifest's capture rules (via
// the generated hook config) — the parser must never hardcode prompt strings.
const codexParser = new CodexJsonlParser({
  envelopePrefixes: systemEnvelopePrefixes('codex'),
  envelopeTags: systemEnvelopeTags('codex'),
});

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

  findTranscript: (sessionId) => findTranscriptFor('codex', sessionId),

  parseTurns: (content) => codexParser.parseTurns(content),
};
