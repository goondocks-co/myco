import { AgentRegistry } from '../agents/registry.js';
import type { AgentAdapter } from '../agents/adapter.js';
import { PROMPT_PREVIEW_CHARS } from '../constants.js';
import fs from 'node:fs';

// Re-export TranscriptTurn from its canonical home in agents/adapter.ts
export type { TranscriptTurn } from '../agents/adapter.js';
import type { TranscriptTurn } from '../agents/adapter.js';

interface TranscriptConfig {
  /** Additional agent adapters to register (useful for testing or custom agents) */
  additionalAdapters?: AgentAdapter[];
}

export class TranscriptMiner {
  private registry: AgentRegistry;

  constructor(config?: TranscriptConfig) {
    this.registry = new AgentRegistry(config?.additionalAdapters);
  }

  /**
   * Extract all conversation turns for a session.
   * Convenience wrapper — delegates to getAllTurnsWithSource.
   */
  getAllTurns(sessionId: string): TranscriptTurn[] {
    return this.getAllTurnsWithSource(sessionId).turns;
  }

  /**
   * Extract turns using the hook-provided transcript path first (fast, no scanning),
   * then fall back to adapter registry scanning if the path isn't provided.
   */
  getAllTurnsWithSource(sessionId: string, transcriptPath?: string): { turns: TranscriptTurn[]; source: string } {
    // Primary: use the path provided by the hook (no directory scanning needed)
    if (transcriptPath) {
      const result = this.registry.parseTurnsFromPath(transcriptPath);
      if (result) return result;
    }

    // Fallback: scan known agent directories
    const result = this.registry.getTranscriptTurns(sessionId);
    if (result) return result;
    return { turns: [], source: 'none' };
  }
}

/**
 * Build turns from buffer events — the fallback when no agent transcript is available.
 * Buffer events come from hooks (user_prompt, tool_use) and lack AI responses.
 * Turns will have prompts and tool counts but no aiResponse.
 */
export function extractTurnsFromBuffer(events: Array<Record<string, unknown>>): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;

  for (const event of events) {
    const type = event.type as string;
    if (type === 'user_prompt') {
      if (current) turns.push(current);
      current = {
        prompt: String(event.prompt ?? '').slice(0, PROMPT_PREVIEW_CHARS),
        toolCount: 0,
        timestamp: String(event.timestamp ?? new Date().toISOString()),
      };
    } else if (type === 'tool_use') {
      if (current) current.toolCount++;
    }
  }
  if (current) turns.push(current);
  return turns;
}
