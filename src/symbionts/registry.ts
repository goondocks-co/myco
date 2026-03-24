import type { SymbiontAdapter, TranscriptTurn } from './adapter.js';
import { claudeCodeAdapter } from './claude-code.js';
import { cursorAdapter } from './cursor.js';
import fs from 'node:fs';

/**
 * All known symbiont adapters, ordered by priority.
 * When searching for a transcript, adapters are tried in order.
 * Add new adapters here as symbiont support grows.
 */
const ALL_ADAPTERS: SymbiontAdapter[] = [
  claudeCodeAdapter,
  cursorAdapter,
];

export class SymbiontRegistry {
  private adapters: SymbiontAdapter[];

  constructor(additionalAdapters: SymbiontAdapter[] = []) {
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
  getAdapter(name: string): SymbiontAdapter | undefined {
    return this.adapters.find((a) => a.name === name);
  }

  /** Detect which symbiont is currently active based on environment variables */
  detectActiveAgent(): SymbiontAdapter | undefined {
    for (const adapter of this.adapters) {
      if (process.env[adapter.pluginRootEnvVar]) {
        return adapter;
      }
    }
    return undefined;
  }

  /**
   * Parse turns from a known transcript file path (provided by hook).
   * Tries each adapter's parseTurns until one produces results.
   * Skips directory scanning entirely — the path is already known.
   */
  parseTurnsFromPath(filePath: string): { turns: TranscriptTurn[]; source: string } | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Try the active agent's parser first, then fall back to others
      const active = this.detectActiveAgent();
      const orderedAdapters = active
        ? [active, ...this.adapters.filter((a) => a !== active)]
        : this.adapters;

      for (const adapter of orderedAdapters) {
        const turns = adapter.parseTurns(content);
        if (turns.length > 0) {
          return { turns, source: `${adapter.name}:direct` };
        }
      }
    } catch {
      // File unreadable — caller will fall back to directory scanning
    }
    return null;
  }

  /**
   * Resolve the plugin root directory from the active agent's environment variable.
   * Returns undefined if no agent env var is set (e.g., running from CLI directly).
   */
  resolvePluginRoot(): string | undefined {
    for (const adapter of this.adapters) {
      const value = process.env[adapter.pluginRootEnvVar];
      if (value) return value;
    }
    return undefined;
  }
}
