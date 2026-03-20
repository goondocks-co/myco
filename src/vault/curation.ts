/**
 * Vault curation — supersession detection pipeline.
 *
 * Given a newly written spore ID, finds older spores of the same observation_type
 * that have been rendered outdated, and marks them as superseded.
 */

import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { MycoIndex, IndexedNote } from '../index/sqlite.js';
import type { VectorIndex } from '../index/vectors.js';
import type { LlmProvider, EmbeddingProvider } from '../intelligence/llm.js';
import { generateEmbedding } from '../intelligence/embeddings.js';
import { stripReasoningTokens } from '../intelligence/response.js';
import { indexNote } from '../index/rebuild.js';
import { loadPrompt } from '../prompts/index.js';
import {
  SUPERSESSION_CANDIDATE_LIMIT,
  SUPERSESSION_VECTOR_FETCH_LIMIT,
  SUPERSESSION_MAX_TOKENS,
  EMBEDDING_INPUT_LIMIT,
  LLM_REASONING_MODE,
} from '../constants.js';

type LogLevel = 'debug' | 'info' | 'warn';
type LogFn = (level: LogLevel, message: string, data?: Record<string, unknown>) => void;

/** Zod schema for validating LLM supersession responses. */
export const supersededIdsSchema = z.array(z.string());

/** Marker string used to detect whether a supersession notice has already been appended. */
export const SUPERSESSION_NOTICE_MARKER = 'Superseded by::';

/** Returns true if a spore should be considered active (including legacy spores without status). */
export function isActiveSpore(frontmatter: Record<string, unknown>): boolean {
  const status = frontmatter.status as string | undefined;
  return !status || status === 'active';
}

/**
 * Mark a single spore as superseded: update frontmatter + append notice in a
 * single read-modify-write, then re-index and remove from vector index.
 * Returns true if the write succeeded, false if the file was not found.
 */
export function supersedeSpore(
  targetId: string,
  newSporeId: string,
  targetPath: string,
  deps: { index: MycoIndex; vectorIndex: VectorIndex | null; vaultDir: string },
): boolean {
  const fullPath = path.join(deps.vaultDir, targetPath);
  let fileContent: string;
  try {
    fileContent = fs.readFileSync(fullPath, 'utf-8');
  } catch {
    return false;
  }

  // Parse and update frontmatter
  const fmMatch = fileContent.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return false;

  const parsed = YAML.parse(fmMatch[1]) as Record<string, unknown>;
  parsed.status = 'superseded';
  parsed.superseded_by = newSporeId;

  const fmYaml = YAML.stringify(parsed, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' }).trim();
  let body = fileContent.slice(fmMatch[0].length);

  // Append supersession notice (idempotent: skip if already present)
  if (!body.includes(SUPERSESSION_NOTICE_MARKER)) {
    const notice = `\n\n> [!warning] Superseded\n> This observation has been superseded.\n\n${SUPERSESSION_NOTICE_MARKER} [[${newSporeId}]]`;
    body = body.trimEnd() + notice + '\n';
  }

  // Atomic write (temp file + rename)
  const tmp = `${fullPath}.tmp`;
  fs.writeFileSync(tmp, `---\n${fmYaml}\n---${body}`, 'utf-8');
  fs.renameSync(tmp, fullPath);

  // Re-index the updated file and remove stale vector
  indexNote(deps.index, deps.vaultDir, targetPath);
  deps.vectorIndex?.delete(targetId);

  return true;
}

/**
 * Check whether the newly written spore with `newSporeId` supersedes any
 * existing active spores of the same observation_type.
 *
 * Returns the list of spore IDs that were marked superseded.
 */
export async function checkSupersession(
  newSporeId: string,
  deps: {
    index: MycoIndex;
    vectorIndex: VectorIndex | null;
    embeddingProvider: EmbeddingProvider;
    llmProvider: LlmProvider | null;
    vaultDir: string;
    log?: LogFn;
  },
): Promise<string[]> {
  const { index, vectorIndex, embeddingProvider, llmProvider, vaultDir, log } = deps;

  // Early-exit if no vector index or LLM available
  if (!vectorIndex || !llmProvider) {
    log?.('debug', 'checkSupersession: skipped — vectorIndex or llmProvider unavailable', { newSporeId });
    return [];
  }

  // Look up the new spore to get its content and observation_type
  const newSporeResults = index.queryByIds([newSporeId]);
  if (newSporeResults.length === 0) {
    log?.('warn', 'checkSupersession: new spore not found in index', { newSporeId });
    return [];
  }
  const newSpore = newSporeResults[0];
  const observationType = newSpore.frontmatter['observation_type'] as string | undefined;

  // Embed the spore content for similarity search
  const embeddingText = newSpore.content.slice(0, EMBEDDING_INPUT_LIMIT);
  const embeddingResult = await generateEmbedding(embeddingProvider, embeddingText);

  // Fetch candidate spore IDs from vector index
  const vectorResults = vectorIndex.search(embeddingResult.embedding, {
    type: 'spore',
    limit: SUPERSESSION_VECTOR_FETCH_LIMIT,
  });

  if (vectorResults.length === 0) {
    log?.('debug', 'checkSupersession: no vector results', { newSporeId });
    return [];
  }

  const candidateIds = vectorResults.map((r) => r.id);

  // Look up candidate notes and post-filter:
  // - same observation_type as the new spore
  // - active status (including legacy spores without status field)
  // - not the new spore itself
  const candidateNotes = index.queryByIds(candidateIds);
  const filtered = candidateNotes
    .filter((note) => {
      if (note.id === newSporeId) return false;
      if (!isActiveSpore(note.frontmatter)) return false;
      if (observationType && note.frontmatter['observation_type'] !== observationType) return false;
      return true;
    })
    .slice(0, SUPERSESSION_CANDIDATE_LIMIT);

  if (filtered.length === 0) {
    log?.('debug', 'checkSupersession: no candidates after filtering', { newSporeId, observationType });
    return [];
  }

  // Build the supersession prompt
  const template = loadPrompt('supersession');
  const newSporeText = `[${newSpore.id}] ${newSpore.title}\n${newSpore.content}`;
  const candidatesText = filtered
    .map((c) => `[${c.id}] ${c.title}\n${c.content}`)
    .join('\n\n');

  const prompt = template
    .replace('{{new_spore}}', newSporeText)
    .replace('{{candidates}}', candidatesText);

  // Ask the LLM which candidates are superseded
  let responseText: string;
  try {
    const response = await llmProvider.summarize(prompt, {
      maxTokens: SUPERSESSION_MAX_TOKENS,
      reasoning: LLM_REASONING_MODE,
    });
    responseText = stripReasoningTokens(response.text);
  } catch (err) {
    log?.('warn', 'checkSupersession: LLM call failed', { newSporeId, error: String(err) });
    return [];
  }

  // Parse the LLM response as a JSON array of IDs
  let rawIds: unknown;
  try {
    rawIds = JSON.parse(responseText);
  } catch {
    log?.('warn', 'checkSupersession: failed to parse LLM response', { newSporeId, responseText });
    return [];
  }

  const parsed = supersededIdsSchema.safeParse(rawIds);
  if (!parsed.success) {
    log?.('warn', 'checkSupersession: LLM response failed schema validation', { newSporeId });
    return [];
  }

  // Filter to IDs that actually exist in the candidate list and are still active
  const candidateMap = new Map<string, IndexedNote>(filtered.map((c) => [c.id, c]));
  const validIds = parsed.data.filter((id) => candidateMap.has(id));

  if (validIds.length === 0) {
    return [];
  }

  // Mark each validated candidate as superseded
  const supersededIds: string[] = [];

  for (const id of validIds) {
    const candidate = candidateMap.get(id)!;
    const wrote = supersedeSpore(id, newSporeId, candidate.path, { index, vectorIndex, vaultDir });

    if (!wrote) {
      log?.('warn', 'checkSupersession: file not found for candidate, skipping', { id, path: candidate.path });
      continue;
    }

    supersededIds.push(id);
    log?.('info', 'checkSupersession: marked superseded', { supersededId: id, newSporeId });
  }

  return supersededIds;
}
