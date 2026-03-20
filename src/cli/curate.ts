/**
 * myco curate — scan the vault for stale spores and supersede them.
 *
 * Usage:
 *   myco curate              Scan and supersede stale spores
 *   myco curate --dry-run    Show what would be superseded without writing
 *
 * Algorithm:
 *   1. Load all active spores from the index
 *   2. Group by observation_type
 *   3. Within each group, embed spores and cluster by cosine similarity
 *   4. For each cluster with 2+ members, ask the LLM which are outdated
 *   5. Mark superseded: update frontmatter, append notice, re-index, remove vector
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../config/loader.js';
import { MycoIndex } from '../index/sqlite.js';
import { VectorIndex } from '../index/vectors.js';
import { indexNote } from '../index/rebuild.js';
import { createLlmProvider, createEmbeddingProvider } from '../intelligence/llm.js';
import { generateEmbedding } from '../intelligence/embeddings.js';
import { stripReasoningTokens } from '../intelligence/response.js';
import { VaultWriter } from '../vault/writer.js';
import { loadPrompt } from '../prompts/index.js';
import {
  CURATION_CLUSTER_SIMILARITY,
  EMBEDDING_INPUT_LIMIT,
  SUPERSESSION_MAX_TOKENS,
  LLM_REASONING_MODE,
} from '../constants.js';

const supersededIdsSchema = z.array(z.string());

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface SporeWithEmbedding {
  id: string;
  path: string;
  title: string;
  content: string;
  created: string;
  frontmatter: Record<string, unknown>;
  embedding: number[];
}

interface Cluster {
  spores: SporeWithEmbedding[];
  centroid: number[];
}

function updateCentroid(spores: SporeWithEmbedding[]): number[] {
  if (spores.length === 0) return [];
  const dim = spores[0].embedding.length;
  const centroid = new Array<number>(dim).fill(0);
  for (const s of spores) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += s.embedding[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    centroid[i] /= spores.length;
  }
  return centroid;
}

function clusterSpores(spores: SporeWithEmbedding[]): Cluster[] {
  const clusters: Cluster[] = [];

  for (const spore of spores) {
    let bestCluster: Cluster | null = null;
    let bestSimilarity = -1;

    for (const cluster of clusters) {
      const sim = cosineSimilarity(spore.embedding, cluster.centroid);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestCluster = cluster;
      }
    }

    if (bestCluster !== null && bestSimilarity >= CURATION_CLUSTER_SIMILARITY) {
      bestCluster.spores.push(spore);
      bestCluster.centroid = updateCentroid(bestCluster.spores);
    } else {
      clusters.push({ spores: [spore], centroid: [...spore.embedding] });
    }
  }

  return clusters;
}

export async function run(args: string[], vaultDir: string): Promise<void> {
  const isDryRun = args.includes('--dry-run');

  const config = loadConfig(vaultDir);
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));

  const llmProvider = createLlmProvider(config.intelligence.llm);
  const embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);

  let vectorIndex: VectorIndex | null = null;
  try {
    const testEmbed = await embeddingProvider.embed('test');
    vectorIndex = new VectorIndex(path.join(vaultDir, 'vectors.db'), testEmbed.dimensions);
  } catch (e) {
    console.error(`Vector index unavailable: ${(e as Error).message}`);
    console.error('Curate requires a working embedding provider.');
    index.close();
    process.exit(1);
  }

  try {
    if (isDryRun) {
      console.log('Dry run — no changes will be written.\n');
    }

    // 1. Query all spores and filter for active ones
    const allSpores = index.query({ type: 'spore' });
    const activeSpores = allSpores.filter(
      (n) => n.frontmatter['status'] === 'active' || !n.frontmatter['status'],
    );

    console.log(`Scanning ${activeSpores.length} active spores...`);

    if (activeSpores.length === 0) {
      console.log('No active spores found.');
      return;
    }

    // 2. Embed all active spores
    const sporesWithEmbeddings: SporeWithEmbedding[] = [];
    let embedFailures = 0;
    for (const spore of activeSpores) {
      try {
        const text = spore.content.slice(0, EMBEDDING_INPUT_LIMIT);
        const result = await generateEmbedding(embeddingProvider, text);
        sporesWithEmbeddings.push({
          id: spore.id,
          path: spore.path,
          title: spore.title,
          content: spore.content,
          created: spore.created,
          frontmatter: spore.frontmatter,
          embedding: result.embedding,
        });
      } catch {
        embedFailures++;
      }
    }

    if (embedFailures > 0) {
      console.log(`Warning: ${embedFailures} spore(s) could not be embedded and were skipped.`);
    }

    // 3. Group by observation_type
    const byType = new Map<string, SporeWithEmbedding[]>();
    for (const spore of sporesWithEmbeddings) {
      const obsType = (spore.frontmatter['observation_type'] as string | undefined) ?? 'unknown';
      if (!byType.has(obsType)) byType.set(obsType, []);
      byType.get(obsType)!.push(spore);
    }

    // 4. Cluster within each type group
    const template = loadPrompt('supersession');
    let totalClusters = 0;
    let totalSuperseded = 0;

    const writer = new VaultWriter(vaultDir);

    for (const [obsType, typeSpores] of byType) {
      const clusters = clusterSpores(typeSpores);
      const multiSpore = clusters.filter((c) => c.spores.length >= 2);

      if (multiSpore.length === 0) continue;

      console.log(`\nType: ${obsType} — ${typeSpores.length} spores, ${multiSpore.length} cluster(s) to evaluate`);
      totalClusters += multiSpore.length;

      for (const cluster of multiSpore) {
        // Sort by created date ascending; newest is last
        const sorted = [...cluster.spores].sort((a, b) => a.created.localeCompare(b.created));
        const newest = sorted[sorted.length - 1];
        const candidates = sorted.slice(0, sorted.length - 1);

        // 5. Build supersession prompt
        const newSporeText = `[${newest.id}] ${newest.title}\n${newest.content}`;
        const candidatesText = candidates
          .map((c) => `[${c.id}] ${c.title}\n${c.content}`)
          .join('\n\n');

        const prompt = template
          .replace('{{new_spore}}', newSporeText)
          .replace('{{candidates}}', candidatesText);

        // 6. Ask LLM which candidates are outdated
        let responseText: string;
        try {
          const response = await llmProvider.summarize(prompt, {
            maxTokens: SUPERSESSION_MAX_TOKENS,
            reasoning: LLM_REASONING_MODE,
          });
          responseText = stripReasoningTokens(response.text);
        } catch (err) {
          console.log(`  Warning: LLM call failed for cluster in ${obsType}: ${String(err)}`);
          continue;
        }

        // Parse response
        let rawIds: unknown;
        try {
          rawIds = JSON.parse(responseText);
        } catch {
          console.log(`  Warning: Could not parse LLM response for cluster in ${obsType}`);
          continue;
        }

        const parsed = supersededIdsSchema.safeParse(rawIds);
        if (!parsed.success) {
          console.log(`  Warning: LLM response schema invalid for cluster in ${obsType}`);
          continue;
        }

        // Validate IDs against actual candidates
        const candidateMap = new Map(candidates.map((c) => [c.id, c]));
        const validIds = parsed.data.filter((id) => candidateMap.has(id));

        if (validIds.length === 0) continue;

        for (const id of validIds) {
          const candidate = candidateMap.get(id)!;

          if (isDryRun) {
            console.log(`  [dry-run] Would supersede: ${candidate.title} (${id})`);
            console.log(`            Superseded by: ${newest.title} (${newest.id})`);
            totalSuperseded++;
            continue;
          }

          // 7. Write supersession: update frontmatter, append notice, re-index, remove vector
          const updated = writer.updateNoteFrontmatter(
            candidate.path,
            { status: 'superseded', superseded_by: newest.id },
            true,
          );

          if (!updated) {
            console.log(`  Warning: file not found for ${id}, skipping write`);
            totalSuperseded++;
            continue;
          }

          const fullPath = path.join(vaultDir, candidate.path);
          const fileContent = fs.readFileSync(fullPath, 'utf-8');
          if (!fileContent.includes('Superseded by::')) {
            const notice = `\n\n> [!warning] Superseded\n> This observation has been superseded.\n\nSuperseded by:: [[${newest.id}]]`;
            fs.writeFileSync(fullPath, fileContent.trimEnd() + notice + '\n', 'utf-8');
          }

          indexNote(index, vaultDir, candidate.path);
          vectorIndex!.delete(id);

          console.log(`  Superseded: ${candidate.title} (${id})`);
          console.log(`  By: ${newest.title} (${newest.id})`);
          totalSuperseded++;
        }
      }
    }

    // 8. Summary
    console.log(`\nCuration complete:`);
    console.log(`  Scanned: ${activeSpores.length} active spores`);
    console.log(`  Clusters evaluated: ${totalClusters}`);
    if (isDryRun) {
      console.log(`  Would supersede: ${totalSuperseded}`);
    } else {
      console.log(`  Superseded: ${totalSuperseded}`);
    }
  } finally {
    index.close();
    vectorIndex?.close();
  }
}
