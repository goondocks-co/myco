import type { AgentAdapter } from './adapter.js';
import type { TranscriptTurn, TranscriptImage } from './adapter.js';
import { mimeTypeForExtension, parseJsonlTurns } from './adapter.js';
import { PROMPT_PREVIEW_CHARS } from '../constants.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Cursor stores conversation transcripts in:
 *   ~/.cursor/projects/<project-path>/agent-transcripts/<session-id>.txt
 *
 * Images are saved as files in:
 *   ~/.cursor/projects/<project-path>/assets/<filename>.png
 *
 * Transcript format is plain text with role markers on their own line:
 *   user:         — human prompt (may contain <image_files> and <user_query> tags)
 *   assistant:    — assistant response (may contain [Tool call] and [Thinking] blocks)
 */

const USER_MARKER = '\nuser:\n';
const ASSISTANT_MARKER = '\nassistant:\n';
const TOOL_CALL_MARKER = '[Tool call]';
const TOOL_RESULT_MARKER = '[Tool result]';
const THINKING_MARKER = '[Thinking]';

function getCursorProjectsBase(): string {
  return path.join(os.homedir(), '.cursor', 'projects');
}

const CURSOR_PROJECTS = getCursorProjectsBase();

export const cursorAdapter: AgentAdapter = {
  name: 'cursor',
  displayName: 'Cursor',
  pluginRootEnvVar: 'CURSOR_PLUGIN_ROOT',

  findTranscript(sessionId: string): string | null {
    try {
      for (const project of fs.readdirSync(CURSOR_PROJECTS, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        const transcriptsDir = path.join(CURSOR_PROJECTS, project.name, 'agent-transcripts');
        // Try .txt (older Cursor) then .jsonl inside session directory (newer Cursor)
        for (const candidate of [
          path.join(transcriptsDir, `${sessionId}.txt`),
          path.join(transcriptsDir, sessionId, `${sessionId}.jsonl`),
        ]) {
          try {
            fs.accessSync(candidate);
            return candidate;
          } catch { /* not here */ }
        }
      }
    } catch { /* projects dir doesn't exist */ }
    return null;
  },

  parseTurns(content: string): TranscriptTurn[] {
    // Detect format: JSONL (starts with '{') or plain text (starts with 'user:')
    const trimmed = content.trimStart();
    if (trimmed.startsWith('{')) {
      return parseCursorJsonl(content);
    }
    return parseCursorText(content);
  },
};

/** Parse Cursor's newer JSONL format — same structure as Claude's but uses 'role' field */
function parseCursorJsonl(content: string): TranscriptTurn[] {
  return parseJsonlTurns(content, {
    roleField: 'role',
    extractTimestamp: false,
    skipToolResultUsers: false,
  });
}

/** Parse Cursor's older plain-text transcript format. */
function parseCursorText(content: string): TranscriptTurn[] {
    const turns: TranscriptTurn[] = [];
    // Split on user marker — each block is a new human turn.
    const sections = ('\n' + content).split(USER_MARKER).slice(1);

    for (const section of sections) {
      // Extract user query from <user_query> tags or raw text before first assistant response
      let promptText = '';
      const queryMatch = section.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
      if (queryMatch) {
        promptText = queryMatch[1].trim().slice(0, PROMPT_PREVIEW_CHARS);
      } else {
        // No tags — take text before the first assistant response.
        const beforeAssistant = section.split(ASSISTANT_MARKER)[0];
        promptText = beforeAssistant.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim().slice(0, PROMPT_PREVIEW_CHARS);
      }

      // Extract image references from <image_files> tags
      const images: TranscriptImage[] = [];
      const imageFilesMatch = section.match(/<image_files>([\s\S]*?)<\/image_files>/);
      if (imageFilesMatch) {
        const imageBlock = imageFilesMatch[1];
        const pathMatches = imageBlock.matchAll(/^\d+\.\s+(.+\.(?:png|jpg|jpeg|gif|webp))\s*$/gmi);
        for (const match of pathMatches) {
          const imagePath = match[1].trim();
          try {
            const data = fs.readFileSync(imagePath).toString('base64');
            const mediaType = mimeTypeForExtension(path.extname(imagePath));
            images.push({ data, mediaType });
          } catch {
            // Image file not accessible — skip
          }
        }
      }

      // Count tool calls in assistant sections
      const toolCallCount = section.split(TOOL_CALL_MARKER).length - 1;

      // Extract the last meaningful assistant text response.
      // Scan assistant blocks (split on \nA:\n) from the end.
      // A block is "meaningful" if it contains lines that aren't tool calls/results/thinking.
      let aiResponse: string | undefined;
      const assistantBlocks = section.split(ASSISTANT_MARKER).slice(1);
      for (let j = assistantBlocks.length - 1; j >= 0; j--) {
        const lines = assistantBlocks[j].split('\n');
        const textLines: string[] = [];
        let skip = false;
        for (const line of lines) {
          // Skip tool calls, tool results, and thinking blocks
          if (line.startsWith(TOOL_CALL_MARKER) || line.startsWith(TOOL_RESULT_MARKER) || line.startsWith(THINKING_MARKER)) {
            skip = true;
            continue;
          }
          // Resume after a blank line following a skipped block
          if (skip && line.trim() === '') continue;
          if (skip && !line.startsWith('  ')) skip = false; // End of indented tool args
          if (skip) continue;
          textLines.push(line);
        }
        const text = textLines.join('\n').trim();
        if (text) {
          aiResponse = text;
          break;
        }
      }

      if (promptText || images.length > 0) {
        turns.push({
          prompt: promptText,
          toolCount: toolCallCount,
          timestamp: '',
          ...(aiResponse ? { aiResponse } : {}),
          ...(images.length > 0 ? { images } : {}),
        });
      }
    }

    return turns;
}
