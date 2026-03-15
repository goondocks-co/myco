/**
 * Prompt loader — reads .md templates from disk and interpolates variables.
 * Prompts are markdown files in this directory, not TypeScript strings.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_TYPES } from '../vault/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const promptCache = new Map<string, string>();

function loadPrompt(name: string): string {
  let cached = promptCache.get(name);
  if (!cached) {
    cached = fs.readFileSync(path.join(__dirname, `${name}.md`), 'utf-8').trim();
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

// --- Prompt builders ---

export function buildExtractionPrompt(
  sessionId: string,
  eventCount: number,
  toolSummary: string,
): string {
  return interpolate(loadPrompt('extraction'), {
    sessionId,
    eventCount: String(eventCount),
    toolSummary,
  });
}

export function buildSummaryPrompt(
  sessionId: string,
  user: string,
  content: string,
): string {
  return interpolate(loadPrompt('summary'), {
    sessionId,
    user,
    content,
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

/** Max chars of file content to include per candidate in the prompt. */
export const CANDIDATE_CONTENT_PREVIEW = 2000;

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
  });
}
