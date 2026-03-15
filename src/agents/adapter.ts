/**
 * Agent adapter interface — declares what each coding agent provides to Myco.
 *
 * Each supported agent (Claude Code, Cursor, Cline, etc.) has an adapter that
 * tells Myco where to find transcripts, how to parse them, and what capabilities
 * the agent supports. The daemon uses these adapters at runtime to read the
 * authoritative conversation record.
 */
import fs from 'node:fs';
import path from 'node:path';

/** An image attached to a conversation turn */
export interface TranscriptImage {
  /** Base64-encoded image data */
  data: string;
  /** MIME type (e.g., image/png) */
  mediaType: string;
}

/** A single conversation turn extracted from an agent's transcript */
export interface TranscriptTurn {
  prompt: string;
  toolCount: number;
  aiResponse?: string;
  timestamp: string;
  /** Images attached to this turn's user prompt */
  images?: TranscriptImage[];
}

export interface AgentAdapter {
  /** Agent identifier (matches plugin directory names) */
  readonly name: string;
  /** Human-readable display name */
  readonly displayName: string;
  /** Environment variable for the plugin root directory */
  readonly pluginRootEnvVar: string;

  /**
   * Find the transcript file for a given session ID.
   * Returns the absolute path if found, null otherwise.
   */
  findTranscript(sessionId: string): string | null;

  /**
   * Parse a transcript file's content into normalized turns.
   * Each adapter handles its agent's specific format.
   */
  parseTurns(content: string): TranscriptTurn[];
}

/**
 * Scan subdirectories of baseDir for a JSONL transcript file matching sessionId.
 * Shared by claude-code, cursor, custom adapters, and tests.
 */
export function findJsonlInSubdirs(baseDir: string, sessionId: string): string | null {
  try {
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(baseDir, entry.name, `${sessionId}.jsonl`);
      try {
        fs.accessSync(candidate);
        return candidate;
      } catch { /* not here */ }
    }
  } catch { /* baseDir doesn't exist or unreadable */ }
  return null;
}

/**
 * Factory for creating simple per-project adapters from a base directory.
 * Used for user-configured transcript_paths and testing.
 */
export function createPerProjectAdapter(
  baseDir: string,
  parseTurns: AgentAdapter['parseTurns'],
  name?: string,
): AgentAdapter {
  return {
    name: name ?? `custom:${path.basename(baseDir)}`,
    displayName: `Custom (${baseDir})`,
    pluginRootEnvVar: '',
    findTranscript: (sessionId) => findJsonlInSubdirs(baseDir, sessionId),
    parseTurns,
  };
}
