import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SymbiontAdapter } from './adapter.js';
import { AntigravityJsonlParser } from './parsers/antigravity-jsonl.js';

/**
 * Google Antigravity symbiont adapter.
 *
 * Plugin bundle root (shared across surfaces): `~/.gemini/config/plugins/<name>/`.
 * Hook contract: JSON stdin/stdout, camelCase fields (`conversationId`,
 * `transcriptPath`, `artifactDirectoryPath`).
 */

/**
 * Per-surface conversation roots scanned by {@link findAntigravityTranscript}.
 * Conversation ID is the directory name. First match wins.
 */
export const ANTIGRAVITY_SURFACE_DIRS = [
  'antigravity-cli',
  'antigravity',
  'antigravity-ide',
] as const;

const TRANSCRIPT_LEAF = path.join('.system_generated', 'logs', 'transcript_full.jsonl');

const antigravityParser = new AntigravityJsonlParser();

/**
 * Locate `transcript_full.jsonl` for a given Antigravity `conversationId`
 * under `<baseDir>/<surface>/brain/<conversationId>/`. Returns null when no
 * surface has the file.
 */
export function findAntigravityTranscript(baseDir: string, conversationId: string): string | null {
  if (!conversationId) return null;
  for (const surface of ANTIGRAVITY_SURFACE_DIRS) {
    const candidate = path.join(baseDir, surface, 'brain', conversationId, TRANSCRIPT_LEAF);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* surface absent or conversation not here */ }
  }
  return null;
}

const ANTIGRAVITY_BASE_DIR = path.join(os.homedir(), '.gemini');

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

  findTranscript: (conversationId) => findAntigravityTranscript(ANTIGRAVITY_BASE_DIR, conversationId),

  parseTurns: (content) => antigravityParser.parseTurns(content),
};
