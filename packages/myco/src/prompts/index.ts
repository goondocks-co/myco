/**
 * Prompt loader for package-owned markdown assets.
 *
 * These prompts are bundled into code at build time so the compiled Bun
 * binary never depends on runtime filesystem reads under /$bunfs/.
 */

import { BUNDLED_PROMPTS } from '../static-assets.generated.js';

const promptCache = new Map<string, string>();

export function loadPrompt(name: string): string {
  let cached = promptCache.get(name);
  if (!cached) {
    const bundled = BUNDLED_PROMPTS[name];
    if (bundled === undefined) {
      throw new Error(`Unknown prompt: ${name}`);
    }
    cached = bundled.trim();
    promptCache.set(name, cached);
  }
  return cached;
}

function interpolate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/** Format an indexed note as a prompt candidate block: `[id] title\ncontent`. */
export function formatNoteForPrompt(note: { id: string; title: string; content: string }): string {
  return `[${note.id}] ${note.title}\n${note.content}`;
}

/** Format multiple notes as a prompt candidates block, separated by double newlines. */
export function formatNotesForPrompt(notes: Array<{ id: string; title: string; content: string }>): string {
  return notes.map(formatNoteForPrompt).join('\n\n');
}

// --- Prompt builders ---

export function buildExtractionPrompt(
  sessionId: string,
  conversation: string,
  maxTokens?: number,
): string {
  return interpolate(loadPrompt('extraction'), {
    sessionId,
    conversation,
    maxTokens: String(maxTokens ?? 2048),
  });
}

export function buildSummaryPrompt(
  sessionId: string,
  user: string,
  content: string,
  maxTokens?: number,
): string {
  return interpolate(loadPrompt('summary'), {
    sessionId,
    user,
    content,
    maxTokens: String(maxTokens ?? 1024),
  });
}

export function buildTitlePrompt(
  summary: string,
  sessionId: string,
): string {
  return interpolate(loadPrompt('title'), {
    summary,
    sessionId,
  });
}

export function buildSimilarityPrompt(
  currentSummary: string,
  candidateSummary: string,
): string {
  return interpolate(loadPrompt('session-similarity'), {
    currentSummary,
    candidateSummary,
  });
}
