import type { SymbiontAdapter } from './adapter.js';
import { CodexJsonlParser } from './parsers/codex-jsonl.js';
import { systemEnvelopePrefixes, systemEnvelopeTags } from './envelope-prefixes.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TRANSCRIPT_BASE = path.join(os.homedir(), '.codex');
// Envelope prefixes/tags come from the codex manifest's capture rules (via
// the generated hook config) — the parser must never hardcode prompt strings.
const codexParser = new CodexJsonlParser({
  envelopePrefixes: systemEnvelopePrefixes('codex'),
  envelopeTags: systemEnvelopeTags('codex'),
});

/**
 * Find a Codex transcript file by session ID.
 *
 * Codex stores transcripts at:
 *   <baseDir>/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl
 *
 * Recursively scans the sessions directory for a JSONL file whose name
 * contains the session ID.
 */
export function findCodexTranscript(baseDir: string, sessionId: string): string | null {
  const sessionsDir = path.join(baseDir, 'sessions');
  try {
    return scanForSessionFile(sessionsDir, sessionId);
  } catch {
    return null;
  }
}

function scanForSessionFile(dir: string, sessionId: string): string | null {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return null; }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = scanForSessionFile(fullPath, sessionId);
      if (found) return found;
    } else if (entry.isFile() && entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
      return fullPath;
    }
  }
  return null;
}

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

  findTranscript: (sessionId) => findCodexTranscript(TRANSCRIPT_BASE, sessionId),

  parseTurns: (content) => codexParser.parseTurns(content),
};
