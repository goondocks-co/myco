/**
 * Symbiont adapter interface — declares what each coding agent provides to Myco.
 *
 * Each supported symbiont (Claude Code, Cursor, Cline, etc.) has an adapter that
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
  /** Per-tool call counts (e.g., { Read: 5, Edit: 3 }). Populated from buffer events. */
  toolBreakdown?: Record<string, number>;
  /** Deduplicated file paths touched in this turn. Populated from buffer events. */
  files?: string[];
  aiResponse?: string;
  timestamp: string;
  /** Images attached to this turn's user prompt */
  images?: TranscriptImage[];
}

/**
 * Dot-path for an agent hook payload field. An ordered list means "try each
 * path in order and use the first one present"; useful for hosts whose outer
 * integration is stable but whose embedded runtime can emit alternate shapes.
 */
export type HookFieldPath = string | readonly string[];

/**
 * Maps agent-specific hook field names to normalized names.
 * Each agent's hook system uses different field names for the same data.
 */
export interface HookFieldNames {
  /** Field name for the session ID (e.g., 'session_id', 'sessionId', 'trajectory_id') */
  sessionId: HookFieldPath;
  /** Field name for the transcript file path (e.g., 'transcript_path') */
  transcriptPath: HookFieldPath;
  /** Field name for the last AI response text (e.g., 'last_assistant_message') */
  lastResponse: HookFieldPath;
  /** Field name for the user prompt (e.g., 'prompt') */
  prompt: HookFieldPath;
  /** Field name for the tool name (e.g., 'tool_name') */
  toolName: HookFieldPath;
  /** Field name for the tool input (e.g., 'tool_input'). Supports dot notation for nested objects. */
  toolInput: HookFieldPath;
  /** Field name for the tool output (e.g., 'tool_output'). Supports dot notation for nested objects. */
  toolOutput: HookFieldPath;
  /** Env var fallback for session ID (e.g., 'GEMINI_SESSION_ID'). */
  sessionIdEnv?: string;
}

export interface SymbiontAdapter {
  /** Agent identifier (matches plugin directory names) */
  readonly name: string;
  /** Human-readable display name */
  readonly displayName: string;
  /** Environment variable for the plugin root directory */
  readonly pluginRootEnvVar: string;
  /** Maps agent-specific hook body field names to normalized names */
  readonly hookFields: HookFieldNames;

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
  parseTurns: SymbiontAdapter['parseTurns'],
  name?: string,
): SymbiontAdapter {
  return {
    name: name ?? `custom:${path.basename(baseDir)}`,
    displayName: `Custom (${baseDir})`,
    pluginRootEnvVar: '',
    hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last_assistant_message', prompt: 'prompt', toolName: 'tool_name', toolInput: 'tool_input', toolOutput: 'tool_output' },
    findTranscript: (sessionId) => findJsonlInSubdirs(baseDir, sessionId),
    parseTurns,
  };
}

/** Map MIME type to file extension */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/png': 'png',
};

export function extensionForMimeType(mimeType: string): string {
  return MIME_TO_EXT[mimeType] ?? 'png';
}

/** Map file extension to MIME type */
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.png': 'image/png',
};

export function mimeTypeForExtension(ext: string): string {
  return EXT_TO_MIME[ext.toLowerCase()] ?? 'image/png';
}

import { StandardJsonlParser } from './parsers/standard-jsonl.js';

export interface ParseJsonlOptions {
  /** Field name containing the message role ('type' for Claude Code, 'role' for Cursor) */
  roleField: 'type' | 'role';
  /** Whether entries have a timestamp field to extract */
  extractTimestamp: boolean;
  /** Whether to check for text-only user messages (Claude Code has tool_result user messages to skip) */
  skipToolResultUsers: boolean;
  /** Whether to strip [Image: source: ...] text references from prompts (Claude Code-specific) */
  stripImageTextRefs: boolean;
}

/**
 * Shared JSONL transcript parser — used by both Claude Code and Cursor adapters.
 * Handles user/assistant role detection, text/image extraction, and tool counting.
 */
export function parseJsonlTurns(content: string, opts: ParseJsonlOptions): TranscriptTurn[] {
  return new StandardJsonlParser(opts).parseTurns(content);
}
