import fs from 'node:fs';
import path from 'node:path';
import type { MycoIndex } from '../index/sqlite.js';
import type { VectorIndex } from '../index/vectors.js';
import type { MycoConfig } from '../config/schema.js';
import type { LlmProvider, EmbeddingProvider } from '../intelligence/llm.js';
import type { DigestCycleResult, DigestLogFn } from '../daemon/digest.js';
import { rebuildIndex, indexNote } from '../index/rebuild.js';
import { initFts } from '../index/fts.js';
import { generateEmbedding } from '../intelligence/embeddings.js';
import { batchExecute, LLM_BATCH_CONCURRENCY, EMBEDDING_BATCH_CONCURRENCY } from '../intelligence/batch.js';
import { DigestEngine } from '../daemon/digest.js';
import type { DigestCycleOptions } from '../daemon/digest.js';
import { BufferProcessor, SUMMARIZATION_FAILED_MARKER } from '../daemon/processor.js';
import { TranscriptMiner } from '../capture/transcript-miner.js';
import { VaultWriter } from '../vault/writer.js';
import { writeObservationNotes } from '../vault/observations.js';
import { createPerProjectAdapter } from '../agents/adapter.js';
import { claudeCodeAdapter } from '../agents/claude-code.js';
import { sessionNoteId, bareSessionId } from '../vault/session-id.js';
import { callout, extractSection, CONVERSATION_HEADING } from '../obsidian/formatter.js';
import matter from 'gray-matter';
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

// --- Reprocess ---

export interface ReprocessOptions {
  /** Filter to sessions matching this substring. */
  session?: string;
  /** Filter to sessions from a specific date (YYYY-MM-DD). */
  date?: string;
  /** Only reprocess sessions with failed summaries. */
  failed?: boolean;
  /** Skip LLM calls — re-index and re-embed only. */
  indexOnly?: boolean;
}

export interface ReprocessResult {
  sessionsFound: number;
  sessionsProcessed: number;
  observationsExtracted: number;
  summariesRegenerated: number;
  embeddingsQueued: number;
}


/**
 * Replace the title (first `# ` line) and summary callout in a session note body.
 */
function updateTitleAndSummary(body: string, newTitle: string, newNarrative: string): string {
  let updated = body.replace(/^# .*/m, `# ${newTitle}`);
  const summaryCallout = callout('abstract', 'Summary', newNarrative);
  updated = updated.replace(/> \[!abstract\] Summary\n(?:> .*\n?)*/m, summaryCallout + '\n');
  return updated;
}

/**
 * Reprocess sessions: re-extract observations, regenerate summaries, re-index.
 * Core logic shared between CLI (`myco reprocess`) and daemon API (`POST /api/reprocess`).
 */
export async function runReprocess(
  ctx: OperationContext,
  llmProvider: LlmProvider | null,
  embeddingProvider: EmbeddingProvider,
  options?: ReprocessOptions,
  onProgress?: (phase: string, done: number, total: number) => void,
): Promise<ReprocessResult> {
  const { vaultDir, config, index } = ctx;
  const log = ctx.log ?? (() => {});

  const sessionFilter = options?.session;
  const dateFilter = options?.date;
  const failedOnly = options?.failed ?? false;
  const skipLlm = options?.indexOnly ?? false;

  const effectiveLlm = skipLlm ? null : llmProvider;
  const processor = effectiveLlm
    ? new BufferProcessor(effectiveLlm, config.intelligence.llm.context_window, config.capture)
    : null;
  const writer = new VaultWriter(vaultDir);
  const miner = new TranscriptMiner({
    additionalAdapters: config.capture.transcript_paths.map((p: string) =>
      createPerProjectAdapter(p, claudeCodeAdapter.parseTurns),
    ),
  });

  // Find sessions
  const sessionsDir = path.join(vaultDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    return { sessionsFound: 0, sessionsProcessed: 0, observationsExtracted: 0, summariesRegenerated: 0, embeddingsQueued: 0 };
  }

  const sessionFiles: Array<{ relativePath: string; sessionId: string }> = [];
  for (const dateDir of fs.readdirSync(sessionsDir)) {
    if (dateFilter && dateDir !== dateFilter) continue;
    const datePath = path.join(sessionsDir, dateDir);
    if (!fs.statSync(datePath).isDirectory()) continue;
    for (const file of fs.readdirSync(datePath)) {
      if (!file.startsWith('session-') || !file.endsWith('.md')) continue;
      const sessionId = file.replace('session-', '').replace('.md', '');
      if (sessionFilter && !sessionId.includes(sessionFilter)) continue;
      sessionFiles.push({ relativePath: path.join('sessions', dateDir, file), sessionId });
    }
  }

  if (sessionFiles.length === 0) {
    return { sessionsFound: 0, sessionsProcessed: 0, observationsExtracted: 0, summariesRegenerated: 0, embeddingsQueued: 0 };
  }

  // Prepare tasks
  interface SessionTask {
    relativePath: string;
    sessionId: string;
    bare: string;
    frontmatter: Record<string, unknown>;
    frontmatterBlock: string;
    body: string;
    conversationSection: string;
    batchEvents: Array<Record<string, unknown>> | null;
    turnCount: number;
    hasFailed: boolean;
  }

  const tasks: SessionTask[] = [];
  for (const { relativePath, sessionId } of sessionFiles) {
    const rawContent = fs.readFileSync(path.join(vaultDir, relativePath), 'utf-8');

    // Quick pre-screen before expensive parsing when filtering to failed sessions only
    const hasFailed = rawContent.includes(SUMMARIZATION_FAILED_MARKER);
    if (failedOnly && !hasFailed) continue;

    const { data: frontmatter, content: body } = matter(rawContent);
    const bare = bareSessionId(sessionId);
    const turnsResult = miner.getAllTurnsWithSource(bare);
    const conversationSection = extractSection(body, CONVERSATION_HEADING);
    const fmEnd = rawContent.indexOf('---', 4);
    const frontmatterBlock = rawContent.slice(0, fmEnd + 3);

    const batchEvents = turnsResult && turnsResult.turns.length > 0
      ? turnsResult.turns.map((t) => ({
          type: 'turn' as const,
          prompt: t.prompt,
          tool_count: t.toolCount,
          response: t.aiResponse ?? '',
          timestamp: t.timestamp,
        }))
      : null;

    tasks.push({ relativePath, sessionId, bare, frontmatter, frontmatterBlock, body, conversationSection, batchEvents, turnCount: turnsResult?.turns.length ?? 0, hasFailed });
  }

  if (tasks.length === 0) {
    return { sessionsFound: sessionFiles.length, sessionsProcessed: 0, observationsExtracted: 0, summariesRegenerated: 0, embeddingsQueued: 0 };
  }

  log('info', `Reprocessing ${tasks.length} session(s)`, { filters: { session: sessionFilter, date: dateFilter, failed: failedOnly, indexOnly: skipLlm } });

  // Fire-and-forget embedding helper — pipelines embeddings as data is produced
  // instead of accumulating all jobs in memory for a separate phase.
  let embeddingsQueued = 0;
  const embedPending: Promise<void>[] = [];
  const fireEmbed = (id: string, text: string, metadata: Record<string, string>) => {
    if (!ctx.vectorIndex) return;
    embeddingsQueued++;
    const vec = ctx.vectorIndex;
    const p = generateEmbedding(embeddingProvider, text)
      .then((emb) => { vec.upsert(id, emb.embedding, metadata); })
      .catch((err) => { log('warn', `Embedding failed for ${id}`, { error: (err as Error).message }); });
    embedPending.push(p);
  };

  // Phase 1: Extraction + FTS re-indexing + inline embeddings
  let totalObservations = 0;

  const extractionResult = await batchExecute(
    tasks,
    async (task) => {
      let obs = 0;

      if (processor && task.batchEvents) {
        const result = await processor.process(task.batchEvents, task.bare);
        if (result.observations.length > 0) {
          writeObservationNotes(result.observations, task.bare, writer, index, vaultDir);
          obs = result.observations.length;
          for (const o of result.observations) {
            fireEmbed(
              `${o.type}-${task.bare.slice(-6)}-${Date.now()}`,
              `${o.title}\n${o.content}`.slice(0, EMBEDDING_INPUT_LIMIT),
              { type: 'spore', session_id: task.bare },
            );
          }
        }
      }

      indexNote(index, vaultDir, task.relativePath);

      const embText = `${task.frontmatter.title ?? ''}\n${task.frontmatter.summary ?? ''}`.slice(0, EMBEDDING_INPUT_LIMIT);
      if (embText.trim()) {
        fireEmbed(sessionNoteId(task.bare), embText, { type: 'session', session_id: task.bare });
      }

      return obs;
    },
    {
      concurrency: LLM_BATCH_CONCURRENCY,
      onProgress: (done, total) => onProgress?.('extraction', done, total),
    },
  );

  for (const r of extractionResult.results) {
    if (r.status === 'fulfilled') totalObservations += r.value;
  }

  // Phase 2: Resummarize
  let summarized = 0;
  if (processor) {
    const summarizableTasks = tasks.filter((t) => t.conversationSection);
    if (summarizableTasks.length > 0) {
      const summaryResult = await batchExecute(
        summarizableTasks,
        async (task) => {
          const user = typeof task.frontmatter.user === 'string' ? task.frontmatter.user : undefined;
          const result = await processor.summarizeSession(task.conversationSection, task.bare, user);

          if (result.summary.includes(SUMMARIZATION_FAILED_MARKER)) {
            log('warn', `Summarization failed for ${task.sessionId.slice(0, 12)}`);
            return false;
          }

          const updatedBody = updateTitleAndSummary(task.body, result.title, result.summary);
          fs.writeFileSync(path.join(vaultDir, task.relativePath), task.frontmatterBlock + updatedBody);
          indexNote(index, vaultDir, task.relativePath);
          return true;
        },
        {
          concurrency: LLM_BATCH_CONCURRENCY,
          onProgress: (done, total) => onProgress?.('summarization', done, total),
        },
      );

      for (const r of summaryResult.results) {
        if (r.status === 'fulfilled' && r.value) summarized++;
      }
    }
  }

  // Wait for all pipelined embeddings to settle
  await Promise.allSettled(embedPending);

  log('info', 'Reprocess completed', {
    sessions: tasks.length,
    observations: totalObservations,
    summaries: summarized,
    embeddings: embeddingsQueued,
  });

  return {
    sessionsFound: sessionFiles.length,
    sessionsProcessed: tasks.length,
    observationsExtracted: totalObservations,
    summariesRegenerated: summarized,
    embeddingsQueued,
  };
}
