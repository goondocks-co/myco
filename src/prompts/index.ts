/**
 * Prompt loader — reads .md templates from disk and interpolates variables.
 * Prompts are markdown files in this directory, not TypeScript strings.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_TYPES } from '../vault/types.js';
import { CANDIDATE_CONTENT_PREVIEW } from '../constants.js';

/**
 * Resolve the prompts directory. With tsup code-splitting, import.meta.url
 * points to a chunk file (dist/chunk-XXXX.js), not dist/src/prompts/.
 * Walk up from the current file to find package.json, then use dist/src/prompts/.
 */
function resolvePromptsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return path.join(dir, 'dist', 'src', 'prompts');
    }
    // Also check if we're already in the right place (tsc output or dev mode)
    if (fs.existsSync(path.join(dir, 'extraction.md'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  // Final fallback: adjacent to current file (works with tsc)
  return path.dirname(fileURLToPath(import.meta.url));
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
  eventCount: number,
  toolSummary: string,
  maxTokens?: number,
): string {
  return interpolate(loadPrompt('extraction'), {
    sessionId,
    eventCount: String(eventCount),
    toolSummary,
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

const ARTIFACT_TYPE_DESCRIPTIONS = [
  '"spec" — Design specifications, architecture documents',
  '"plan" — Implementation plans, roadmaps',
  '"rfc" — Requests for comment, proposals',
  '"doc" — Documentation, guides, READMEs',
  '"other" — Other substantive documents',
];

export function buildSimilarityPrompt(
  currentSummary: string,
  candidateSummary: string,
): string {
  return interpolate(loadPrompt('session-similarity'), {
    currentSummary,
    candidateSummary,
  });
}

export function buildClassificationPrompt(
  sessionId: string,
  candidates: Array<{ path: string; content: string }>,
  maxTokens?: number,
): string {
  const fileList = candidates
    .map((c) => {
      const truncated = c.content.slice(0, CANDIDATE_CONTENT_PREVIEW);
      return `### ${c.path}\n\`\`\`\n${truncated}\n\`\`\``;
    })
    .join('\n\n');

  return interpolate(loadPrompt('classification'), {
    sessionId,
    fileList,
    artifactTypes: ARTIFACT_TYPE_DESCRIPTIONS.map((d) => `- ${d}`).join('\n'),
    validTypes: ARTIFACT_TYPES.join('|'),
    maxTokens: String(maxTokens ?? 1024),
  });
}
