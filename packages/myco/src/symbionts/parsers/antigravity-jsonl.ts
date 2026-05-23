import type { TranscriptParser } from './types.js';
import type { TranscriptTurn } from '../adapter.js';
import { PROMPT_PREVIEW_CHARS } from '../../constants.js';

/**
 * Parser for Antigravity `transcript_full.jsonl`. Each line is one step:
 *
 *   { step_index, source, type, status, created_at, content?, tool_calls?, thinking? }
 *
 * Types handled:
 *   - `USER_INPUT`        → opens a new turn; `content` wraps the prompt in
 *                           `<USER_REQUEST>` plus `<ADDITIONAL_METADATA>` and
 *                           `<USER_SETTINGS_CHANGE>` envelopes that this
 *                           parser strips via {@link cleanAntigravityUserPrompt}.
 *   - `PLANNER_RESPONSE`  → if `tool_calls[]` is non-empty, each entry adds
 *                           to `toolCount` + `toolBreakdown` (per name) +
 *                           `files` (path-bearing args only). If empty and
 *                           `content` is non-empty, the row carries the
 *                           assistant's user-visible reply for the turn.
 *   - Result rows (`MCP_TOOL`, `RUN_COMMAND`, `VIEW_FILE`, `LIST_DIRECTORY`,
 *     `SYSTEM_MESSAGE`, `CONVERSATION_HISTORY`) → ignored.
 */
export class AntigravityJsonlParser implements TranscriptParser {
  parseTurns(content: string): TranscriptTurn[] {
    const lines = content.split('\n').filter(Boolean);
    const turns: TranscriptTurn[] = [];
    let current: TranscriptTurn | null = null;

    for (const line of lines) {
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line); } catch { continue; }

      const type = entry.type as string | undefined;
      const timestamp = (entry.created_at as string) ?? '';

      if (type === 'USER_INPUT') {
        const rawContent = typeof entry.content === 'string' ? entry.content : '';
        const promptText = cleanAntigravityUserPrompt(rawContent).slice(0, PROMPT_PREVIEW_CHARS);
        // AGY re-emits the same USER_INPUT at step 0 of each execution within
        // one logical turn; skip the duplicate.
        if (current && current.prompt === promptText) continue;
        if (current) turns.push(current);
        current = { prompt: promptText, toolCount: 0, timestamp };
        continue;
      }

      if (type === 'PLANNER_RESPONSE') {
        if (!current) continue;
        const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];

        if (toolCalls.length > 0) {
          for (const call of toolCalls as Array<{ name?: unknown; args?: unknown }>) {
            const name = typeof call.name === 'string' && call.name.length > 0 ? call.name : 'unknown';
            current.toolCount += 1;
            current.toolBreakdown ??= {};
            current.toolBreakdown[name] = (current.toolBreakdown[name] ?? 0) + 1;
            const filePath = extractAntigravityFilePath(name, call.args);
            if (filePath) {
              current.files ??= [];
              if (!current.files.includes(filePath)) current.files.push(filePath);
            }
          }
        } else if (typeof entry.content === 'string' && entry.content.trim().length > 0) {
          // Last PLANNER_RESPONSE with prose wins; AGY emits intermediate
          // narration rows between tool calls that aren't the final reply.
          current.aiResponse = entry.content;
        }
      }
    }

    if (current) turns.push(current);
    return turns;
  }
}

/**
 * Extract the body of `<USER_REQUEST>…</USER_REQUEST>` from an
 * Antigravity `USER_INPUT.content` and remove the `<ADDITIONAL_METADATA>`
 * and `<USER_SETTINGS_CHANGE>` envelopes. Falls back to whole-string
 * envelope-strip when no `<USER_REQUEST>` wrapper is present.
 */
export function cleanAntigravityUserPrompt(raw: string): string {
  const requestMatch = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  const body = requestMatch ? requestMatch[1] : raw;
  return body
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .trim();
}

/**
 * Map an Antigravity tool call's args to its path-bearing argument, when one
 * exists. Returns null for tools whose args carry no path (`run_command`,
 * `call_mcp_tool`, `schedule`, etc.).
 *
 * Arg-name source: https://antigravity.google/docs/hooks
 */
export function extractAntigravityFilePath(toolName: string, args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const obj = args as Record<string, unknown>;
  const candidate = (() => {
    switch (toolName) {
      case 'view_file': return obj.AbsolutePath;
      case 'write_to_file': return obj.TargetFile;
      case 'replace_file_content':
      case 'multi_replace_file_content':
        return obj.TargetFile;
      case 'list_dir': return obj.DirectoryPath;
      case 'find_by_name': return obj.SearchDirectory;
      case 'grep_search': return obj.SearchPath;
      default: return null;
    }
  })();
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}
