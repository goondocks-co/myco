import type { SymbiontAdapter, TranscriptTurn } from './adapter.js';
import { PROMPT_PREVIEW_CHARS } from '../constants.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TRANSCRIPT_DIR = path.join(os.homedir(), '.windsurf', 'transcripts');

/** Windsurf JSONL entry type field values. */
const USER_INPUT_TYPE = 'user_input';
const PLANNER_RESPONSE_TYPE = 'planner_response';
const CODE_ACTION_TYPE = 'code_action';

export const windsurfAdapter: SymbiontAdapter = {
  name: 'windsurf',
  displayName: 'Windsurf',
  pluginRootEnvVar: 'WINDSURF_PLUGIN_ROOT',
  hookFields: {
    sessionId: 'trajectory_id',
    transcriptPath: 'transcript_path',
    lastResponse: 'last_assistant_message',
    prompt: 'prompt',
    toolName: 'tool_name',
    toolInput: 'tool_input',
    toolOutput: 'tool_output',
  },

  findTranscript(sessionId: string): string | null {
    // Windsurf stores transcripts directly by trajectory ID
    const candidate = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch { return null; }
  },

  parseTurns(content: string): TranscriptTurn[] {
    return parseWindsurfJsonl(content);
  },
};

/**
 * Parse Windsurf's JSONL transcript format.
 *
 * Windsurf entries use a `type` field with values like 'user_input',
 * 'planner_response', 'code_action' — NOT the standard user/assistant roles.
 */
function parseWindsurfJsonl(content: string): TranscriptTurn[] {
  const lines = content.split('\n').filter(Boolean);
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }

    const type = entry.type as string;

    if (type === USER_INPUT_TYPE) {
      if (current) turns.push(current);

      // Extract prompt text — Windsurf may store it in different fields
      const promptText = (
        (entry.user_response as string) ??
        (entry.text as string) ??
        (entry.content as string) ??
        ''
      ).trim().slice(0, PROMPT_PREVIEW_CHARS);

      current = { prompt: promptText, toolCount: 0, timestamp: '' };
    } else if (type === PLANNER_RESPONSE_TYPE && current) {
      const text = (
        (entry.response as string) ??
        (entry.text as string) ??
        (entry.content as string) ??
        ''
      ).trim();
      if (text) current.aiResponse = text;
    } else if (type === CODE_ACTION_TYPE && current) {
      current.toolCount++;
    }
  }

  if (current) turns.push(current);
  return turns;
}
