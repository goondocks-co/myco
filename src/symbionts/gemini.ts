import type { SymbiontAdapter, TranscriptTurn } from './adapter.js';
import { PROMPT_PREVIEW_CHARS } from '../constants.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Gemini CLI stores transcripts as single JSON files (not JSONL) in:
 *   ~/.gemini/tmp/<project-name>/chats/session-<date>-<sessionId>.json
 *
 * Each file has a messages array with type: 'user' | 'gemini'.
 * User messages have content as array of { text } blocks.
 * Gemini messages have content as a string, with optional toolCalls array.
 */

const GEMINI_TMP = path.join(os.homedir(), '.gemini', 'tmp');

export const geminiAdapter: SymbiontAdapter = {
  name: 'gemini',
  displayName: 'Gemini CLI',
  pluginRootEnvVar: 'GEMINI_PLUGIN_ROOT',
  hookFields: {
    sessionId: 'session_id',
    transcriptPath: 'transcript_path',
    lastResponse: 'last_assistant_message',
    prompt: 'prompt',
    toolName: 'tool_name',
    toolInput: 'tool_input',
    toolOutput: 'tool_output',
    sessionIdEnv: 'GEMINI_SESSION_ID',
  },

  findTranscript(sessionId: string): string | null {
    // Gemini session files are named session-<date>-<sessionId-prefix>.json
    // and stored under ~/.gemini/tmp/<project>/chats/
    // The sessionId in the filename is a prefix of the full UUID.
    try {
      for (const project of fs.readdirSync(GEMINI_TMP, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        const chatsDir = path.join(GEMINI_TMP, project.name, 'chats');
        try {
          for (const file of fs.readdirSync(chatsDir)) {
            if (!file.endsWith('.json')) continue;
            // Match by sessionId prefix in filename (session-<date>-<prefix>.json)
            if (file.includes(sessionId.slice(0, 8))) {
              // Verify the sessionId inside the file matches
              try {
                const data = JSON.parse(fs.readFileSync(path.join(chatsDir, file), 'utf-8'));
                if (data.sessionId === sessionId) {
                  return path.join(chatsDir, file);
                }
              } catch { /* malformed file */ }
            }
          }
        } catch { /* chats dir doesn't exist */ }
      }
    } catch { /* tmp dir doesn't exist */ }
    return null;
  },

  parseTurns(content: string): TranscriptTurn[] {
    return parseGeminiJson(content);
  },
};

/** Gemini message types. */
const USER_TYPE = 'user';
const GEMINI_TYPE = 'gemini';

/**
 * Parse Gemini's single-JSON transcript format.
 * The file contains { messages: [...] } where each message has type, content, and optional toolCalls.
 */
function parseGeminiJson(content: string): TranscriptTurn[] {
  let data: { messages?: GeminiMessage[] };
  try { data = JSON.parse(content); } catch { return []; }

  const messages = data.messages;
  if (!Array.isArray(messages)) return [];

  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;

  for (const msg of messages) {
    if (msg.type === USER_TYPE) {
      if (current) turns.push(current);

      // User content is an array of { text } blocks
      const promptText = Array.isArray(msg.content)
        ? msg.content.map((b) => b.text ?? '').join('\n').trim()
        : (typeof msg.content === 'string' ? msg.content : '');

      current = {
        prompt: promptText.slice(0, PROMPT_PREVIEW_CHARS),
        toolCount: 0,
        timestamp: msg.timestamp ?? '',
      };
    } else if (msg.type === GEMINI_TYPE && current) {
      // Gemini content is a plain string
      const text = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (text) current.aiResponse = text;

      // Count tool calls
      if (Array.isArray(msg.toolCalls)) {
        current.toolCount += msg.toolCalls.length;
      }
    }
  }

  if (current) turns.push(current);
  return turns;
}

/** Shape of a message in Gemini's transcript JSON. */
interface GeminiMessage {
  type: string;
  content: string | Array<{ text?: string }>;
  timestamp?: string;
  toolCalls?: Array<{ name: string; args?: unknown }>;
}
