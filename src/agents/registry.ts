import type { AgentAdapter, TranscriptTurn } from './adapter.js';
import { claudeCodeAdapter } from './claude-code.js';
import { cursorAdapter } from './cursor.js';
import fs from 'node:fs';

/**
 * All known agent adapters, ordered by priority.
 * When searching for a transcript, adapters are tried in order.
 * Add new adapters here as agent support grows.
 */
const ALL_ADAPTERS: AgentAdapter[] = [
  claudeCodeAdapter,
  cursorAdapter,
];

export class AgentRegistry {
  private adapters: AgentAdapter[];

  constructor(additionalAdapters: AgentAdapter[] = []) {
    this.adapters = [...ALL_ADAPTERS, ...additionalAdapters];
  }

  /**
   * Find and parse transcript turns for a session.
   * Tries each adapter in priority order. Returns the first match.
   */
  getTranscriptTurns(sessionId: string): { turns: TranscriptTurn[]; source: string } | null {
    for (const adapter of this.adapters) {
      const filePath = adapter.findTranscript(sessionId);
      if (!filePath) continue;

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const turns = adapter.parseTurns(content);
        if (turns.length > 0) {
          return { turns, source: adapter.name };
        }
      } catch {
        // Adapter found a path but read/parse failed — try next
      }
    }
    return null;
  }

  /** List all registered adapter names */
  get adapterNames(): string[] {
    return this.adapters.map((a) => a.name);
  }

  /** Get a specific adapter by name */
  getAdapter(name: string): AgentAdapter | undefined {
    return this.adapters.find((a) => a.name === name);
  }

  /** Detect which agent is currently active based on environment variables */
  detectActiveAgent(): AgentAdapter | undefined {
    for (const adapter of this.adapters) {
      if (process.env[adapter.pluginRootEnvVar]) {
        return adapter;
      }
    }
    return undefined;
  }
}
