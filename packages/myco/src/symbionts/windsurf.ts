import type { SymbiontAdapter, TranscriptTurn } from './adapter.js';
import { PROMPT_PREVIEW_CHARS } from '../constants.js';
import { findTranscriptFor } from './transcript-discovery.js';

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

  findTranscript: (sessionId) => findTranscriptFor('windsurf', sessionId),

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

    if (entry === null || typeof entry !== 'object') continue;
    const type = entry.type;

    if (type === USER_INPUT_TYPE) {
      if (current) turns.push(current);

      const prompt = [entry.user_response, entry.text, entry.content].find((value): value is string => typeof value === 'string');
      if (prompt === undefined && [entry.user_response, entry.text, entry.content].some(value => value !== undefined && value !== null)) { current = null; continue; }
      const promptText = (prompt ?? '').trim().slice(0, PROMPT_PREVIEW_CHARS);

      current = { prompt: promptText, toolCount: 0, timestamp: '' };
    } else if (type === PLANNER_RESPONSE_TYPE && current) {
      const text = [entry.response, entry.text, entry.content].find((value): value is string => typeof value === 'string')?.trim();
      if (text) current.aiResponse = text;
    } else if (type === CODE_ACTION_TYPE && current) {
      current.toolCount++;
    }
  }

  if (current) turns.push(current);
  return turns;
}
