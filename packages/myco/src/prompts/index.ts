/**
 * Prompt loader — reads .md templates from disk and interpolates variables.
 * Prompts are markdown files in this directory, not TypeScript strings.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageRoot } from '../utils/find-package-root.js';

/**
 * Resolve the prompts directory. With tsup code-splitting, import.meta.url
 * points to a chunk file (dist/chunk-XXXX.js), not dist/src/prompts/.
 */
function resolvePromptsDir(): string {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));

  // Check if we're already in the prompts directory (tsc output or dev mode)
  if (fs.existsSync(path.join(scriptDir, 'extraction.md'))) return scriptDir;

  // Walk up to package root, then use dist/src/prompts/
  const root = findPackageRoot(scriptDir);
  if (root) return path.join(root, 'dist', 'src', 'prompts');

  return scriptDir;
}

const PROMPTS_DIR = resolvePromptsDir();

const promptCache = new Map<string, string>();

export function loadPrompt(name: string): string {
  let cached = promptCache.get(name);
  if (!cached) {
    cached = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf-8').trim();
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

