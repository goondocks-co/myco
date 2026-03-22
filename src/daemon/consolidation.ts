/**
 * ConsolidationEngine — daemon pre-pass that finds clusters of related spores
 * and consolidates them into wisdom notes via LLM.
 *
 * Runs before each digest cycle (or on its own timer) to reduce spore noise
 * by merging semantically similar observations of the same type.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { MycoIndex } from '@myco/index/sqlite.js';
import type { VectorIndex } from '@myco/index/vectors.js';
import type { LlmProvider, EmbeddingProvider } from '@myco/intelligence/llm.js';
import { generateEmbedding } from '@myco/intelligence/embeddings.js';
import { stripReasoningTokens, extractJson } from '@myco/intelligence/response.js';
import { isActiveSpore } from '@myco/vault/curation.js';
import { consolidateSpores } from '@myco/vault/consolidation.js';
import { loadPrompt, formatNotesForPrompt } from '@myco/prompts/index.js';
import { readLastTimestamp, appendTraceRecord } from './trace.js';
import {
  CONSOLIDATION_MIN_CLUSTER_SIZE,
  CONSOLIDATION_VECTOR_FETCH_LIMIT,
  CONSOLIDATION_MAX_TOKENS,
  EMBEDDING_INPUT_LIMIT,
  LLM_REASONING_MODE,
} from '@myco/constants.js';

// --- Types ---

export interface ConsolidationPassResult {
  timestamp: string;
  sporesChecked: number;
  clustersFound: number;
  consolidated: number;
  sporesSuperseded: number;
  durationMs: number;
}

export interface ConsolidationEngineConfig {
  vaultDir: string;
  index: MycoIndex;
  vectorIndex: VectorIndex | null;
  llmProvider: LlmProvider | null;
  embeddingProvider: EmbeddingProvider | null;
  maxTokens?: number;
  log?: (level: 'debug' | 'info' | 'warn', message: string, data?: Record<string, unknown>) => void;
}

// --- Zod schema for LLM response ---

const consolidationResponseSchema = z.discriminatedUnion('consolidate', [
  z.object({ consolidate: z.literal(false), reason: z.string().optional() }),
  z.object({
    consolidate: z.literal(true),
    title: z.string(),
    content: z.string(),
    source_ids: z.array(z.string()),
    tags: z.array(z.string()).optional(),
  }),
]);

/** Path within digest/ to store the consolidation trace. */
const CONSOLIDATION_TRACE_FILENAME = 'consolidation-trace.jsonl';

// --- ConsolidationEngine ---

export class ConsolidationEngine {
  private readonly deps: {
    vaultDir: string;
    index: MycoIndex;
    vectorIndex: VectorIndex | null;
    llmProvider: LlmProvider | null;
    embeddingProvider: EmbeddingProvider | null;
  };

  private readonly maxTokens: number;
  private log: NonNullable<ConsolidationEngineConfig['log']>;
  private lastTimestampCache: string | null | undefined = undefined;

  constructor(config: ConsolidationEngineConfig) {
    this.deps = {
      vaultDir: config.vaultDir,
      index: config.index,
      vectorIndex: config.vectorIndex,
      llmProvider: config.llmProvider,
      embeddingProvider: config.embeddingProvider,
    };
    this.maxTokens = config.maxTokens ?? CONSOLIDATION_MAX_TOKENS;
    this.log = config.log ?? (() => {});
  }

  /**
   * Read the timestamp of the last consolidation pass from the trace file.
   * Cached in memory after first read — subsequent calls are O(1).
   */
  getLastTimestamp(): string | null {
    if (this.lastTimestampCache !== undefined) return this.lastTimestampCache;

    const tracePath = path.join(this.deps.vaultDir, 'digest', CONSOLIDATION_TRACE_FILENAME);
    this.lastTimestampCache = readLastTimestamp(tracePath);
    return this.lastTimestampCache;
  }

  /**
   * Append a consolidation pass result as a JSON line to the trace file.
   * Updates the in-memory timestamp cache.
   */
  appendTrace(record: ConsolidationPassResult): void {
    const tracePath = path.join(this.deps.vaultDir, 'digest', CONSOLIDATION_TRACE_FILENAME);
    appendTraceRecord(tracePath, record as unknown as Record<string, unknown>);
    this.lastTimestampCache = record.timestamp;
  }

  /**
   * Run one consolidation pass.
   *
   * Algorithm:
   * 1. Early-exit if vectorIndex or llmProvider is absent.
   * 2. Query index for spores created since lastTimestamp.
   * 3. Filter for active spores.
   * 4. For each new spore (skip if already processed):
   *    a. Embed it.
   *    b. Vector-search for similar spores.
   *    c. Fetch candidate notes; filter same-type + active + not-processed.
   *    d. Include trigger spore in cluster if not already present.
   *    e. Skip if cluster < CONSOLIDATION_MIN_CLUSTER_SIZE.
   *    f. Ask LLM whether to consolidate.
   *    g. If approved, call consolidateSpores(); track counts.
   *    h. Mark cluster members as processed regardless of outcome.
   * 5. Append trace record, return result.
   *
   * Returns null if no new spores were found or dependencies are absent.
   */
  async runPass(): Promise<ConsolidationPassResult | null> {
    const { vaultDir, index, vectorIndex, llmProvider, embeddingProvider } = this.deps;

    if (!vectorIndex || !llmProvider || !embeddingProvider) {
      this.log('debug', 'ConsolidationEngine: skipped — vectorIndex, llmProvider, or embeddingProvider unavailable');
      return null;
    }

    const startTime = Date.now();
    const lastTimestamp = this.getLastTimestamp();

    // Query for spores created since last pass
    const allSpores = index.query({ type: 'spore', since: lastTimestamp ?? undefined });
    const newSpores = allSpores.filter((n) => isActiveSpore(n.frontmatter));

    this.log('debug', 'ConsolidationEngine: spores to check', {
      count: newSpores.length,
      lastTimestamp: lastTimestamp ?? 'never',
    });

    if (newSpores.length === 0) {
      return null;
    }

    const processedIds = new Set<string>();
    let clustersFound = 0;
    let consolidated = 0;
    let sporesSuperseded = 0;
    const template = loadPrompt('consolidation');

    for (const triggerSpore of newSpores) {
      if (processedIds.has(triggerSpore.id)) continue;

      const observationType = triggerSpore.frontmatter['observation_type'] as string | undefined;

      // Get embedding for similarity search — reuse stored vector if available
      let embedding: number[];
      const storedEmbedding = vectorIndex.getEmbedding(triggerSpore.id);
      if (storedEmbedding) {
        embedding = storedEmbedding;
      } else {
        try {
          const embeddingText = triggerSpore.content.slice(0, EMBEDDING_INPUT_LIMIT);
          const result = await generateEmbedding(embeddingProvider, embeddingText);
          embedding = result.embedding;
        } catch (err) {
          this.log('warn', 'ConsolidationEngine: embedding failed', { id: triggerSpore.id, error: String(err) });
          processedIds.add(triggerSpore.id);
          continue;
        }
      }

      // Vector search for similar spores
      const vectorResults = vectorIndex.search(embedding, {
        type: 'spore',
        limit: CONSOLIDATION_VECTOR_FETCH_LIMIT,
      });

      if (vectorResults.length === 0) {
        processedIds.add(triggerSpore.id);
        continue;
      }

      // Fetch candidates from index
      const candidateIds = vectorResults.map((r) => r.id);
      const candidateNotes = index.queryByIds(candidateIds);

      // Filter: same observation_type, active, not already processed
      const filtered = candidateNotes.filter((note) => {
        if (processedIds.has(note.id)) return false;
        if (!isActiveSpore(note.frontmatter)) return false;
        if (observationType && note.frontmatter['observation_type'] !== observationType) return false;
        return true;
      });

      // Build the cluster: include trigger spore if not already present
      const clusterMap = new Map(filtered.map((n) => [n.id, n]));
      if (!clusterMap.has(triggerSpore.id)) {
        clusterMap.set(triggerSpore.id, triggerSpore);
      }
      const cluster = Array.from(clusterMap.values());

      if (cluster.length < CONSOLIDATION_MIN_CLUSTER_SIZE) {
        this.log('debug', 'ConsolidationEngine: cluster too small — skipping', {
          triggerId: triggerSpore.id,
          clusterSize: cluster.length,
          minRequired: CONSOLIDATION_MIN_CLUSTER_SIZE,
        });
        cluster.forEach((n) => processedIds.add(n.id));
        continue;
      }

      clustersFound++;
      this.log('debug', 'Consolidation groups formed', {
        group_count: clustersFound,
        total_notes: cluster.length,
      });

      // Build consolidation prompt
      const candidatesText = formatNotesForPrompt(cluster);

      const prompt = template
        .replace('{{count}}', String(cluster.length))
        .replace('{{observation_type}}', observationType ?? 'unknown')
        .replace('{{candidates}}', candidatesText)
        .replace('{{maxTokens}}', String(this.maxTokens));

      // Ask LLM whether to consolidate
      let responseText: string;
      try {
        const response = await llmProvider.summarize(prompt, {
          maxTokens: this.maxTokens,
          reasoning: LLM_REASONING_MODE,
        });
        responseText = stripReasoningTokens(response.text);
      } catch (err) {
        this.log('warn', 'ConsolidationEngine: LLM call failed', {
          triggerId: triggerSpore.id,
          error: String(err),
        });
        cluster.forEach((n) => processedIds.add(n.id));
        continue;
      }

      // Parse LLM response
      let parsed: z.infer<typeof consolidationResponseSchema>;
      try {
        const raw = extractJson(responseText);
        const result = consolidationResponseSchema.safeParse(raw);
        if (!result.success) {
          this.log('warn', 'ConsolidationEngine: LLM response failed schema validation', {
            triggerId: triggerSpore.id,
            responseText,
          });
          cluster.forEach((n) => processedIds.add(n.id));
          continue;
        }
        parsed = result.data;
      } catch {
        this.log('warn', 'ConsolidationEngine: failed to parse LLM response', {
          triggerId: triggerSpore.id,
          responseText,
        });
        cluster.forEach((n) => processedIds.add(n.id));
        continue;
      }

      if (!parsed.consolidate) {
        this.log('debug', 'ConsolidationEngine: LLM declined to consolidate', {
          triggerId: triggerSpore.id,
          reason: (parsed as { reason?: string }).reason,
        });
        cluster.forEach((n) => processedIds.add(n.id));
        continue;
      }

      // Validate source_ids — must be a subset of cluster IDs
      const clusterIdSet = new Set(cluster.map((n) => n.id));
      const validSourceIds = parsed.source_ids.filter((id) => clusterIdSet.has(id));

      if (validSourceIds.length < CONSOLIDATION_MIN_CLUSTER_SIZE) {
        this.log('warn', 'ConsolidationEngine: insufficient valid source_ids after validation', {
          triggerId: triggerSpore.id,
          sourceIds: parsed.source_ids,
          validCount: validSourceIds.length,
        });
        cluster.forEach((n) => processedIds.add(n.id));
        continue;
      }

      // Call shared consolidation core
      try {
        const consolidateResult = await consolidateSpores(
          {
            sourceSporeIds: validSourceIds,
            consolidatedContent: parsed.content,
            observationType: observationType ?? 'gotcha',
            tags: parsed.tags,
          },
          {
            vaultDir,
            index,
            vectorIndex,
            embeddingProvider: embeddingProvider ?? null,
          },
        );

        consolidated++;
        sporesSuperseded += consolidateResult.sources_archived;

        this.log('info', 'Notes consolidated', {
          wisdomId: consolidateResult.wisdom_id,
          sourcesArchived: consolidateResult.sources_archived,
          clusterSize: cluster.length,
          similarity: vectorResults[0]?.similarity ?? 0,
        });
      } catch (err) {
        this.log('warn', 'ConsolidationEngine: consolidateSpores failed', {
          triggerId: triggerSpore.id,
          error: String(err),
        });
      }

      cluster.forEach((n) => processedIds.add(n.id));
    }

    if (clustersFound === 0) {
      this.log('debug', 'Consolidation: no groups above threshold');
    }

    const passTimestamp = new Date().toISOString();
    const durationMs = Date.now() - startTime;

    const passResult: ConsolidationPassResult = {
      timestamp: passTimestamp,
      sporesChecked: newSpores.length,
      clustersFound,
      consolidated,
      sporesSuperseded,
      durationMs,
    };

    if (consolidated > 0) {
      // Only write trace records for passes that actually consolidated something
      this.appendTrace(passResult);
    } else {
      // Still advance the timestamp cache so we don't re-examine the same spores
      this.lastTimestampCache = passTimestamp;
    }

    this.log('info', 'ConsolidationEngine: pass complete', {
      sporesChecked: newSpores.length,
      clustersFound,
      consolidated,
      sporesSuperseded,
      durationMs,
    });

    return passResult;
  }
}
