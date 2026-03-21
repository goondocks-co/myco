/**
 * Shared consolidation core — creates a wisdom note from a set of source spores
 * and marks each source as superseded.
 *
 * Used by both the MCP tool (`myco_consolidate`) and the daemon's automatic
 * consolidation pass so the logic lives in exactly one place.
 */

import { VaultWriter } from './writer.js';
import { supersedeSpore } from './curation.js';
import { indexNote } from '../index/rebuild.js';
import type { MycoIndex } from '../index/sqlite.js';
import type { VectorIndex } from '../index/vectors.js';
import type { EmbeddingProvider } from '../intelligence/llm.js';
import { generateEmbedding } from '../intelligence/embeddings.js';
import { EMBEDDING_INPUT_LIMIT } from '../constants.js';
import { randomBytes } from 'node:crypto';

export interface ConsolidateInput {
  sourceSporeIds: string[];
  consolidatedContent: string;
  observationType: string;
  tags?: string[];
}

export interface ConsolidateResult {
  wisdom_id: string;
  wisdom_path: string;
  sources_archived: number;
}

export interface ConsolidateDeps {
  vaultDir: string;
  index: MycoIndex;
  vectorIndex: VectorIndex | null;
  embeddingProvider: EmbeddingProvider | null;
}

/**
 * Create a consolidated wisdom note from a list of source spore IDs, then
 * mark each source spore as superseded.
 *
 * - The wisdom note is written via VaultWriter.writeSpore() with 'wisdom' and
 *   'consolidated' tags appended.
 * - `consolidated_from` is added to the wisdom note's frontmatter.
 * - Each source spore is updated atomically via `supersedeSpore` (frontmatter
 *   update + notice append + re-index + vector deletion).
 * - The wisdom note is indexed and, if deps are available, embedded with
 *   importance 'high' (fire-and-forget).
 *
 * Source spores missing from the index are silently skipped.
 */
export async function consolidateSpores(
  input: ConsolidateInput,
  deps: ConsolidateDeps,
): Promise<ConsolidateResult> {
  const { vaultDir, index, vectorIndex, embeddingProvider } = deps;
  const writer = new VaultWriter(vaultDir);

  const wisdomId = `${input.observationType}-wisdom-${randomBytes(4).toString('hex')}`;

  // Build content with a ## Sources section containing Obsidian wikilinks
  const sourceLinks = input.sourceSporeIds.map((id) => `- [[${id}]]`).join('\n');
  const sourcesSection = input.sourceSporeIds.length > 0
    ? `\n\n## Sources\n\nConsolidated from:\n${sourceLinks}`
    : '';
  const fullContent = `${input.consolidatedContent}${sourcesSection}`;

  // Write the wisdom spore note
  const wisdomPath = writer.writeSpore({
    id: wisdomId,
    observation_type: input.observationType,
    tags: [...(input.tags ?? []), 'wisdom', 'consolidated'],
    content: fullContent,
  });

  // Add consolidated_from to the wisdom note's frontmatter
  writer.updateNoteFrontmatter(wisdomPath, {
    consolidated_from: input.sourceSporeIds,
  }, true);

  // Supersede each source spore (atomic frontmatter update + notice + re-index + vector delete)
  const sourceNotes = index.queryByIds(input.sourceSporeIds);
  const sourceNoteMap = new Map(sourceNotes.map((n) => [n.id, n]));
  let sourcesArchived = 0;
  for (const sourceId of input.sourceSporeIds) {
    const note = sourceNoteMap.get(sourceId);
    if (!note) continue;

    const superseded = supersedeSpore(sourceId, wisdomId, note.path, {
      index,
      vectorIndex,
      vaultDir,
    });

    if (superseded) sourcesArchived++;
  }

  // Index the new wisdom note
  indexNote(index, vaultDir, wisdomPath);

  // Embed the wisdom note (fire-and-forget — embedding failure is non-fatal)
  if (vectorIndex && embeddingProvider) {
    generateEmbedding(embeddingProvider, fullContent.slice(0, EMBEDDING_INPUT_LIMIT))
      .then((emb) =>
        vectorIndex.upsert(wisdomId, emb.embedding, {
          type: 'spore',
          observation_type: input.observationType,
          importance: 'high',
        }),
      )
      .catch(() => { /* embedding failure is non-fatal */ });
  }

  return {
    wisdom_id: wisdomId,
    wisdom_path: wisdomPath,
    sources_archived: sourcesArchived,
  };
}
