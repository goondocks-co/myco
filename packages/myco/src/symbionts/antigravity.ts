import type { SymbiontAdapter, TranscriptTurn } from './adapter.js';

/**
 * Google Antigravity — successor to the retired Gemini CLI symbiont.
 *
 * Antigravity uses a fundamentally different integration model than Gemini CLI:
 *   - Workspace plugin bundles under `.agents/plugins/<name>/` (or
 *     `~/.gemini/config/plugins/<name>/` globally).
 *   - JSON stdin/stdout hook contract with camelCase metadata
 *     (conversationId, transcriptPath, artifactDirectoryPath).
 *   - Hook events: PreInvocation, PostToolUse, PreToolUse, PostInvocation, Stop.
 *
 * Transcript-format and findTranscript() parsing land alongside the dogfood
 * pass in Step 18 — by design Antigravity slots in like Codex/Claude Code,
 * so the adapter shape mirrors them. The body below is a structural stub
 * sufficient for the registry to recognize the symbiont; live parsing
 * lights up when we capture a real Antigravity transcript.
 */
export const antigravityAdapter: SymbiontAdapter = {
  name: 'antigravity',
  displayName: 'Google Antigravity',
  pluginRootEnvVar: 'ANTIGRAVITY_PLUGIN_ROOT',
  hookFields: {
    sessionId: 'conversationId',
    transcriptPath: 'transcriptPath',
    lastResponse: 'lastAssistantMessage',
    prompt: 'prompt',
    toolName: 'toolName',
    toolInput: 'toolInput',
    toolOutput: 'toolOutput',
  },

  findTranscript(_sessionId: string): string | null {
    return null;
  },

  parseTurns(_content: string): TranscriptTurn[] {
    return [];
  },
};
