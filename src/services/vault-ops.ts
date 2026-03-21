import type { MycoIndex } from '../index/sqlite.js';
import type { VectorIndex } from '../index/vectors.js';
import type { MycoConfig } from '../config/schema.js';
import type { LlmProvider, EmbeddingProvider } from '../intelligence/llm.js';
import type { DigestCycleResult, DigestLogFn } from '../daemon/digest.js';
import { rebuildIndex } from '../index/rebuild.js';
import { initFts } from '../index/fts.js';
import { generateEmbedding } from '../intelligence/embeddings.js';
import { batchExecute, EMBEDDING_BATCH_CONCURRENCY } from '../intelligence/batch.js';
import { DigestEngine } from '../daemon/digest.js';
import type { DigestCycleOptions } from '../daemon/digest.js';
import {
  EMBEDDING_INPUT_LIMIT,
  CURATION_CLUSTER_SIMILARITY,
  SUPERSESSION_MAX_TOKENS,
  LLM_REASONING_MODE,
} from '../constants.js';
import { stripReasoningTokens } from '../intelligence/response.js';
import { loadPrompt, formatNoteForPrompt, formatNotesForPrompt } from '../prompts/index.js';
import { supersedeSpore, supersededIdsSchema, isActiveSpore } from '../vault/curation.js';

export interface OperationContext {
  vaultDir: string;
  config: MycoConfig;
  index: MycoIndex;
  vectorIndex?: VectorIndex;
  log?: (level: string, message: string, data?: Record<string, unknown>) => void;
}

// --- Rebuild ---

export interface RebuildResult {
  ftsCount: number;
  embeddedCount: number;
  failedCount: number;
  skippedCount: number;
}

/**
 * Rebuild FTS index and re-embed all active notes.
 * Core logic shared between CLI (`myco rebuild`) and daemon API (`POST /api/rebuild`).
 */
export async function runRebuild(
  ctx: OperationContext,
  embeddingProvider: EmbeddingProvider,
  onProgress?: (done: number, total: number) => void,
): Promise<RebuildResult> {
  const { index, vaultDir } = ctx;

  // Phase 1: FTS rebuild
  initFts(index);
  const ftsCount = rebuildIndex(index, vaultDir);

  // Phase 2: Vector embeddings
  if (!ctx.vectorIndex) {
    return { ftsCount, embeddedCount: 0, failedCount: 0, skippedCount: 0 };
  }

  const allNotes = index.query({});
  // Skip superseded/archived spores
  const activeNotes = allNotes.filter((n) => {
    const status = (n.frontmatter as Record<string, unknown>)?.status as string | undefined;
    return status !== 'superseded' && status !== 'archived';
  });
  const skippedCount = allNotes.length - activeNotes.length;

  const vec = ctx.vectorIndex;
  const result = await batchExecute(
    activeNotes,
    async (note) => {
      const text = `${note.title}\n${note.content}`.slice(0, EMBEDDING_INPUT_LIMIT);
      const emb = await generateEmbedding(embeddingProvider, text);
      vec.upsert(note.id, emb.embedding, {
        type: note.type,
        session_id: (note.frontmatter as Record<string, unknown>)?.session as string ?? '',
      });
    },
    {
      concurrency: EMBEDDING_BATCH_CONCURRENCY,
      onProgress,
    },
  );

  return {
    ftsCount,
    embeddedCount: result.succeeded,
    failedCount: result.failed,
    skippedCount,
  };
}

// --- Digest ---

export interface DigestOptions {
  tier?: number;
  full?: boolean;
}

/**
 * Run a single digest cycle.
 * Core logic shared between CLI (`myco digest`) and daemon API (`POST /api/digest`).
 */
export async function runDigest(
  ctx: OperationContext,
  llmProvider: LlmProvider,
  options?: DigestOptions,
): Promise<DigestCycleResult | null> {
  const { config, vaultDir, index } = ctx;

  const log: DigestLogFn = ctx.log
    ? (level, message, data) => ctx.log!(level, message, data)
    : () => {};

  const engine = new DigestEngine({
    vaultDir,
    index,
    llmProvider,
    config,
    log,
  });

  const opts: DigestCycleOptions = {};
  const isReprocess = options?.full || options?.tier !== undefined;

  if (isReprocess) {
    opts.fullReprocess = true;
    opts.cleanSlate = true;
  }
  if (options?.tier !== undefined) {
    const eligible = engine.getEligibleTiers();
    if (!eligible.includes(options.tier)) {
      throw new Error(`Tier ${options.tier} is not eligible. Eligible tiers: [${eligible.join(', ')}]`);
    }
    opts.tiers = [options.tier];
  }

  return engine.runCycle(opts);
}

// --- Curation ---

export interface CurationDeps {
  vaultDir: string;
  config: MycoConfig;
  index: MycoIndex;
  vectorIndex: VectorIndex;
  llmProvider: LlmProvider;
  embeddingProvider: EmbeddingProvider;
  log?: (level: string, message: string, data?: Record<string, unknown>) => void;
}

export interface CurationResult {
  scanned: number;
  clustersEvaluated: number;
  superseded: number;
}

// --- Curation internals ---

/** Max concurrent embedding requests to avoid overwhelming the provider. */
const CURATION_EMBEDDING_BATCH_SIZE = 10;

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

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
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

/**
 * Run vault curation: embed spores, cluster, ask LLM which are outdated, supersede.
 * Core logic shared between CLI (`myco curate`) and daemon API (`POST /api/curate`).
 */
export async function runCuration(
  deps: CurationDeps,
  dryRun: boolean,
): Promise<CurationResult> {
  const { index, vectorIndex, llmProvider, embeddingProvider, vaultDir } = deps;
  const log = deps.log ?? (() => {});

  // 1. Query all spores and filter for active ones
  const allSpores = index.query({ type: 'spore' });
  const activeSpores = allSpores.filter((n) => isActiveSpore(n.frontmatter));

  if (activeSpores.length === 0) {
    return { scanned: 0, clustersEvaluated: 0, superseded: 0 };
  }

  // 2. Embed all active spores (batched for concurrency)
  const sporesWithEmbeddings: SporeWithEmbedding[] = [];
  let embedFailures = 0;

  for (let i = 0; i < activeSpores.length; i += CURATION_EMBEDDING_BATCH_SIZE) {
    const batch = activeSpores.slice(i, i + CURATION_EMBEDDING_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (spore) => {
        const text = spore.content.slice(0, EMBEDDING_INPUT_LIMIT);
        const result = await generateEmbedding(embeddingProvider, text);
        return { spore, embedding: result.embedding };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { spore, embedding } = result.value;
        sporesWithEmbeddings.push({
          id: spore.id,
          path: spore.path,
          title: spore.title,
          content: spore.content,
          created: spore.created,
          frontmatter: spore.frontmatter,
          embedding,
        });
      } else {
        embedFailures++;
      }
    }
  }

  if (embedFailures > 0) {
    log('warn', `${embedFailures} spore(s) could not be embedded and were skipped`);
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

  for (const [obsType, typeSpores] of byType) {
    const clusters = clusterSpores(typeSpores);
    const multiSpore = clusters.filter((c) => c.spores.length >= 2);
    if (multiSpore.length === 0) continue;

    log('info', `Type: ${obsType} — ${typeSpores.length} spores, ${multiSpore.length} cluster(s) to evaluate`);
    totalClusters += multiSpore.length;

    for (const cluster of multiSpore) {
      const sorted = [...cluster.spores].sort((a, b) => a.created.localeCompare(b.created));
      const newest = sorted[sorted.length - 1];
      const candidates = sorted.slice(0, sorted.length - 1);

      // Build supersession prompt
      const newSporeText = formatNoteForPrompt(newest);
      const candidatesText = formatNotesForPrompt(candidates);

      const prompt = template
        .replace('{{new_spore}}', newSporeText)
        .replace('{{candidates}}', candidatesText);

      // Ask LLM which candidates are outdated
      let responseText: string;
      try {
        const response = await llmProvider.summarize(prompt, {
          maxTokens: SUPERSESSION_MAX_TOKENS,
          reasoning: LLM_REASONING_MODE,
        });
        responseText = stripReasoningTokens(response.text);
      } catch (err) {
        log('warn', `LLM call failed for cluster in ${obsType}: ${String(err)}`);
        continue;
      }

      // Parse response
      let rawIds: unknown;
      try {
        rawIds = JSON.parse(responseText);
      } catch {
        log('warn', `Could not parse LLM response for cluster in ${obsType}`);
        continue;
      }

      const parsed = supersededIdsSchema.safeParse(rawIds);
      if (!parsed.success) {
        log('warn', `LLM response schema invalid for cluster in ${obsType}`);
        continue;
      }

      // Validate IDs against actual candidates
      const candidateMap = new Map(candidates.map((c) => [c.id, c]));
      const validIds = parsed.data.filter((id) => candidateMap.has(id));
      if (validIds.length === 0) continue;

      for (const id of validIds) {
        const candidate = candidateMap.get(id)!;

        if (dryRun) {
          log('info', `[dry-run] Would supersede: ${candidate.title} (${id}) by ${newest.title} (${newest.id})`);
          totalSuperseded++;
          continue;
        }

        const wrote = supersedeSpore(id, newest.id, candidate.path, { index, vectorIndex, vaultDir });
        if (!wrote) {
          log('warn', `File not found for ${id}, skipping write`);
          continue;
        }

        log('info', `Superseded: ${candidate.title} (${id}) by ${newest.title} (${newest.id})`);
        totalSuperseded++;
      }
    }
  }

  return {
    scanned: activeSpores.length,
    clustersEvaluated: totalClusters,
    superseded: totalSuperseded,
  };
}
