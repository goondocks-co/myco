import type { AgentAdapter } from './adapter.js';
import type { TranscriptTurn, TranscriptImage } from './adapter.js';
import { findJsonlInSubdirs } from './adapter.js';
import { PROMPT_PREVIEW_CHARS } from '../constants.js';
import path from 'node:path';
import os from 'node:os';

const TRANSCRIPT_BASE = path.join(os.homedir(), '.claude', 'projects');

export const claudeCodeAdapter: AgentAdapter = {
  name: 'claude-code',
  displayName: 'Claude Code',
  pluginRootEnvVar: 'CLAUDE_PLUGIN_ROOT',

  findTranscript: (sessionId) => findJsonlInSubdirs(TRANSCRIPT_BASE, sessionId),

  parseTurns(content: string): TranscriptTurn[] {
    const lines = content.split('\n').filter(Boolean);
    const turns: TranscriptTurn[] = [];
    let current: TranscriptTurn | null = null;

    for (const line of lines) {
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line); } catch { continue; }

      const type = entry.type as string;
      const timestamp = entry.timestamp as string ?? '';

      if (type === 'user') {
        // In Claude's API format, "user" entries include BOTH human prompts (text blocks)
        // and tool results (tool_result blocks). Only human prompts start a new turn.
        // Tool result messages are part of the ongoing tool-use cycle within the same turn.
        const msg = entry.message as { content?: Array<{ type: string; text?: string }> } | undefined;
        const blocks = Array.isArray(msg?.content) ? msg!.content : [];
        const hasText = blocks.some((b) => b.type === 'text' && b.text?.trim());

        if (hasText) {
          if (current) turns.push(current);

          const promptText = blocks
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text!)
            .join('\n')
            .trim()
            .slice(0, PROMPT_PREVIEW_CHARS);

          // Capture any image blocks attached to this prompt
          const imageBlocks = blocks.filter((b) => b.type === 'image') as Array<{ source?: { type?: string; data?: string; media_type?: string } }>;
          const images: TranscriptImage[] = imageBlocks
            .filter((b) => b.source?.type === 'base64' && b.source.data)
            .map((b) => ({ data: b.source!.data!, mediaType: b.source!.media_type ?? 'image/png' }));

          current = { prompt: promptText, toolCount: 0, timestamp, ...(images.length > 0 ? { images } : {}) };
        }
      } else if (type === 'assistant' && current) {
        const msg = entry.message as { content?: Array<{ type: string; text?: string }> } | undefined;
        if (Array.isArray(msg?.content)) {
          const textParts = msg!.content
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text!);
          const text = textParts.join('\n').trim();
          if (text) current.aiResponse = text;

          const toolUseCount = msg!.content.filter((b) => b.type === 'tool_use').length;
          current.toolCount += toolUseCount;
        }
      }
    }

    if (current) turns.push(current);
    return turns;
  },
};
