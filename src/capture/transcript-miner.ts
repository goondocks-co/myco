import { AgentRegistry } from '../agents/registry.js';
import type { AgentAdapter } from '../agents/adapter.js';
import { PROMPT_PREVIEW_CHARS } from '../constants.js';

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
   * Extract all conversation turns from a session's transcript.
   * Tries each registered agent adapter in priority order.
   * Returns turns in chronological order, or empty if no transcript found.
   */
  getAllTurns(sessionId: string): TranscriptTurn[] {
    const result = this.registry.getTranscriptTurns(sessionId);
    return result?.turns ?? [];
  }

  /**
   * Extract turns and report which agent's transcript was used.
   * The daemon uses the source for logging.
   */
  getAllTurnsWithSource(sessionId: string): { turns: TranscriptTurn[]; source: string } {
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
