import type { TranscriptTurn } from '../adapter.js';

/**
 * Contract for parsing agent transcript files into normalized conversation turns.
 *
 * Each agent's transcript format (JSONL structure, field names, content block types)
 * gets its own implementation. The daemon and capture pipeline operate on
 * TranscriptTurn[] — they never see agent-specific formats.
 */
export interface TranscriptParser {
  parseTurns(content: string): TranscriptTurn[];
}
