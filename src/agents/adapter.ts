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

/**
 * Maps agent-specific hook field names to normalized names.
 * Each agent's hook system uses different field names for the same data.
 */
export interface HookFieldNames {
  /** Field name for the transcript file path (e.g., 'transcript_path') */
  transcriptPath: string;
  /** Field name for the last AI response text (e.g., 'last_assistant_message') */
  lastResponse: string;
  /** Field name for the session ID (e.g., 'session_id') */
  sessionId: string;
}

export interface AgentAdapter {
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

  /**
   * Write MYCO_VAULT_DIR into this agent's project-level config file.
   * Called during init when the vault is outside the project root.
   * Returns true if the config was written, false if not applicable.
   */
  configureVaultEnv(projectRoot: string, vaultDir: string): boolean;
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
    hookFields: { transcriptPath: 'transcript_path', lastResponse: 'last_assistant_message', sessionId: 'session_id' },
    findTranscript: (sessionId) => findJsonlInSubdirs(baseDir, sessionId),
    parseTurns,
    configureVaultEnv: () => false,
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

import { PROMPT_PREVIEW_CHARS } from '../constants.js';

/** Claude Code injects [Image: source: /path] text alongside base64 image blocks. Strip these since the actual images are captured as Obsidian embeds. */
const IMAGE_TEXT_REF_PATTERN = /\[Image: source: [^\]]+\]\n*/g;

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
  const lines = content.split('\n').filter(Boolean);
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }

    const role = entry[opts.roleField] as string;
    const timestamp = opts.extractTimestamp ? (entry.timestamp as string ?? '') : '';

    if (role === 'user') {
      const msg = entry.message as { content?: Array<{ type: string; text?: string; source?: { type?: string; data?: string; media_type?: string } }> } | undefined;
      const blocks = Array.isArray(msg?.content) ? msg!.content : [];
      const hasText = blocks.some((b) => b.type === 'text' && b.text?.trim());

      if (!hasText && opts.skipToolResultUsers) continue;
      if (!hasText) continue;

      if (current) turns.push(current);

      const rawPrompt = blocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join('\n');

      const promptText = (opts.stripImageTextRefs ? rawPrompt.replace(IMAGE_TEXT_REF_PATTERN, '') : rawPrompt)
        .trim()
        .slice(0, PROMPT_PREVIEW_CHARS);

      const images: TranscriptImage[] = blocks
        .filter((b) => b.type === 'image' && b.source?.type === 'base64' && b.source.data)
        .map((b) => ({ data: b.source!.data!, mediaType: b.source!.media_type ?? 'image/png' }));

      current = { prompt: promptText, toolCount: 0, timestamp, ...(images.length > 0 ? { images } : {}) };
    } else if (role === 'assistant' && current) {
      const msg = entry.message as { content?: Array<{ type: string; text?: string }> } | undefined;
      if (Array.isArray(msg?.content)) {
        const textParts = msg!.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text!);
        const text = textParts.join('\n').trim();
        if (text) current.aiResponse = text;
        current.toolCount += msg!.content.filter((b) => b.type === 'tool_use').length;
      }
    }
  }

  if (current) turns.push(current);
  return turns;
}
