import { SymbiontRegistry } from '../symbionts/registry.js';
import type { SymbiontAdapter } from '../symbionts/adapter.js';
import { PROMPT_PREVIEW_CHARS } from '../constants.js';
import fs from 'node:fs';
import { listBatchesBySession, updateBatchKind } from '../db/queries/batches.js';
import { extractUserPromptKinds } from './prompt-kind.js';

// Re-export TranscriptTurn from its canonical home in symbionts/adapter.ts
export type { TranscriptTurn } from '../symbionts/adapter.js';
import type { TranscriptTurn } from '../symbionts/adapter.js';

interface TranscriptConfig {
  /** Additional symbiont adapters to register (useful for testing or custom symbionts) */
  additionalAdapters?: SymbiontAdapter[];
}

export interface ReconcileInput {
  agent: string;
  transcriptPath: string;
}

export interface ReconcileResult {
  reclassified: number;
  errors: string[];
}

export class TranscriptMiner {
  private registry: SymbiontRegistry;

  constructor(config?: TranscriptConfig) {
    this.registry = new SymbiontRegistry(config?.additionalAdapters);
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

  /**
   * Walk the transcript in order, rebuild the intended (kind, parent_id) for
   * each user prompt, and repair any batches whose kind drifted from reality.
   */
  public reconcileBatchKinds(sessionId: string, input: ReconcileInput): ReconcileResult {
    const batches = listBatchesBySession(sessionId).sort((a, b) => a.id - b.id);
    const classifications = extractUserPromptKinds(input.agent, this.parseAllEvents(input.transcriptPath));

    const n = Math.min(batches.length, classifications.length);
    let reclassified = 0;
    const errors: string[] = [];

    let currentParentId: number | null = null;

    for (let i = 0; i < n; i++) {
      const batch = batches[i];
      const wantKind = classifications[i];

      if (wantKind === 'initial') {
        currentParentId = batch.id;
        if (batch.kind !== 'initial' || batch.parent_prompt_batch_id !== null) {
          updateBatchKind(batch.id, 'initial', null);
          reclassified++;
        }
      } else {
        if (currentParentId == null) {
          errors.push(`batch ${batch.id} classified as ${wantKind} but no open parent`);
          continue;
        }
        if (batch.kind !== wantKind || batch.parent_prompt_batch_id !== currentParentId) {
          updateBatchKind(batch.id, wantKind, currentParentId);
          reclassified++;
        }
      }
    }

    if (batches.length !== classifications.length) {
      errors.push(`batch/event count mismatch: ${batches.length} batches vs ${classifications.length} transcript prompts`);
    }

    return { reclassified, errors };
  }

  private parseAllEvents(transcriptPath: string): Array<Record<string, unknown>> {
    try {
      const text = fs.readFileSync(transcriptPath, 'utf8');
      return text.split('\n').filter((l) => l.trim()).map((l) => {
        try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; }
      });
    } catch {
      return [];
    }
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
