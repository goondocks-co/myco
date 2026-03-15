import { DaemonServer } from './server.js';
import { SessionRegistry } from './lifecycle.js';
import { DaemonLogger } from './logger.js';
import { loadConfig } from '../config/loader.js';
import { BatchManager, type BatchEvent } from './batch.js';
import { BufferProcessor, type Observation, type ClassifiedArtifact } from './processor.js';
import { VaultWriter } from '../vault/writer.js';
import { MycoIndex } from '../index/sqlite.js';
import { indexNote, rebuildIndex } from '../index/rebuild.js';
import { initFts } from '../index/fts.js';
import { createLlmProvider, createEmbeddingProvider } from '../intelligence/llm.js';
import type { EmbeddingProvider } from '../intelligence/llm.js';
import { VectorIndex } from '../index/vectors.js';
import { generateEmbedding } from '../intelligence/embeddings.js';
import { LineageGraph, LINEAGE_SIMILARITY_THRESHOLD, LINEAGE_SIMILARITY_HIGH_CONFIDENCE, LINEAGE_SIMILARITY_CANDIDATES, LINEAGE_SIMILARITY_MAX_TOKENS, type LineageLink } from './lineage.js';
import type { RegisteredSession } from './lifecycle.js';
import { PlanWatcher } from './watcher.js';
import { buildInjectedContext } from '../context/injector.js';
import { buildSimilarityPrompt, CANDIDATE_CONTENT_PREVIEW } from '../prompts/index.js';
import { TranscriptMiner } from '../capture/transcript-miner.js';
import { EventBuffer } from '../capture/buffer.js';
import { formatSessionBody } from '../obsidian/formatter.js';
import { writeObservationNotes } from '../vault/observations.js';
import { collectArtifactCandidates } from '../artifacts/candidates.js';
import { slugifyPath } from '../artifacts/slugify.js';
import { sessionNoteId, bareSessionId, sessionWikilink, sessionRelativePath } from '../vault/session-id.js';
import { z } from 'zod';
import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface IndexDeps {
  index: MycoIndex;
  vaultDir: string;
  vectorIndex: VectorIndex | null;
  embeddingProvider: EmbeddingProvider;
  logger: DaemonLogger;
}

function indexAndEmbed(
  relativePath: string,
  noteId: string,
  embeddingText: string,
  metadata: Record<string, string>,
  deps: IndexDeps,
): void {
  indexNote(deps.index, deps.vaultDir, relativePath);
  if (deps.vectorIndex && embeddingText) {
    generateEmbedding(deps.embeddingProvider, embeddingText.slice(0, 8000))
      .then((emb) => deps.vectorIndex!.upsert(noteId, emb.embedding, metadata))
      .catch((err) => deps.logger.debug('embeddings', 'Embedding failed', { id: noteId, error: (err as Error).message }));
  }
}

function writeObservations(
  observations: Observation[],
  sessionId: string,
  deps: IndexDeps & { vault: VaultWriter },
): void {
  const written = writeObservationNotes(observations, sessionId, deps.vault, deps.index, deps.vaultDir);
  for (const note of written) {
    indexAndEmbed(note.path, note.id, `${note.observation.title}\n${note.observation.content}`,
      { type: 'memory', importance: 'high', session_id: sessionId }, deps);
    deps.logger.info('processor', 'Observation written', { type: note.observation.type, title: note.observation.title, session_id: sessionId });
  }
}

async function captureArtifacts(
  candidates: Array<{ path: string; content: string }>,
  classified: ClassifiedArtifact[],
  sessionId: string,
  deps: IndexDeps & { vault: VaultWriter },
): Promise<void> {
  const candidateMap = new Map(candidates.map((c) => [c.path, c]));

  for (const artifact of classified) {
    const candidate = candidateMap.get(artifact.source_path);
    if (!candidate) continue;

    const artifactId = slugifyPath(artifact.source_path);
    const artifactPath = deps.vault.writeArtifact({
      id: artifactId,
      artifact_type: artifact.artifact_type,
      source_path: artifact.source_path,
      title: artifact.title,
      session: sessionId,
      tags: artifact.tags,
      content: candidate.content,
    });
    indexAndEmbed(artifactPath, artifactId, `${artifact.title}\n${candidate.content}`,
      { type: 'artifact', artifact_type: artifact.artifact_type, session_id: sessionId }, deps);
    deps.logger.info('processor', 'Artifact captured', {
      id: artifactId,
      type: artifact.artifact_type,
      source: artifact.source_path,
    });
  }
}

interface Turn {
  prompt: string;
  toolCount: number;
  aiResponse?: string;
}

function extractTurns(events: BatchEvent[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const event of events) {
    if (event.type === 'user_prompt') {
      if (current) turns.push(current);
      current = { prompt: String(event.prompt ?? '').slice(0, 300), toolCount: 0 };
    } else if (event.type === 'ai_response') {
      if (current) current.aiResponse = String((event as Record<string, unknown>).content ?? '');
    } else {
      if (current) current.toolCount++;
    }
  }
  if (current) turns.push(current);
  return turns;
}

export function migrateMemoryFiles(vaultDir: string): number {
  const memoriesDir = path.join(vaultDir, 'memories');
  if (!fs.existsSync(memoriesDir)) return 0;

  let moved = 0;
  const entries = fs.readdirSync(memoriesDir);

  for (const entry of entries) {
    const fullPath = path.join(memoriesDir, entry);
    if (!entry.endsWith('.md')) continue;
    if (fs.statSync(fullPath).isDirectory()) continue;

    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;

      const parsed = YAML.parse(fmMatch[1]) as Record<string, unknown>;
      const obsType = parsed.observation_type as string | undefined;
      if (!obsType) continue;

      const normalizedType = obsType.replace(/_/g, '-');
      const targetDir = path.join(memoriesDir, normalizedType);
      fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, entry);
      fs.renameSync(fullPath, targetPath);
      // Touch the file so Obsidian detects the move and re-indexes backlinks
      const now = new Date();
      fs.utimesSync(targetPath, now, now);
      moved++;
    } catch {
      // Skip files that can't be read or parsed
    }
  }

  return moved;
}

async function main(): Promise<void> {
  const vaultArg = process.argv.find((_, i) => process.argv[i - 1] === '--vault');
  if (!vaultArg) {
    process.stderr.write('Usage: mycod --vault <path>\n');
    process.exit(1);
  }

  const vaultDir = path.resolve(vaultArg);
  const config = loadConfig(vaultDir);

  const logger = new DaemonLogger(path.join(vaultDir, 'logs'), {
    level: config.daemon.log_level,
    maxSize: config.daemon.max_log_size,
  });

  const server = new DaemonServer({ vaultDir, logger });

  const registry = new SessionRegistry({
    gracePeriod: config.daemon.grace_period,
    onEmpty: async () => {
      logger.info('daemon', 'Grace period expired, shutting down');
      planWatcher.stopFileWatcher();
      await server.stop();
      vectorIndex?.close();
      index.close();
      logger.close();
      process.exit(0);
    },
  });

  // Batch processing setup
  const llmProvider = createLlmProvider(config.intelligence.llm);
  const embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);

  let vectorIndex: VectorIndex | null = null;
  try {
    const testEmbed = await embeddingProvider.embed('test');
    vectorIndex = new VectorIndex(path.join(vaultDir, 'vectors.db'), testEmbed.dimensions);
    logger.info('embeddings', 'Vector index initialized', { dimensions: testEmbed.dimensions });
  } catch (error) {
    logger.warn('embeddings', 'Vector index unavailable', { error: (error as Error).message });
  }

  const processor = new BufferProcessor(llmProvider, config.intelligence.llm.context_window);
  const vault = new VaultWriter(vaultDir);
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));
  const lineageGraph = new LineageGraph(vaultDir);
  const transcriptMiner = new TranscriptMiner({
    additionalPaths: config.capture.transcript_paths,
  });

  const indexDeps: IndexDeps = { index, vaultDir, vectorIndex, embeddingProvider, logger };

  const bufferDir = path.join(vaultDir, 'buffer');
  const sessionBuffers = new Map<string, EventBuffer>();
  const sessionFilePaths = new Map<string, Set<string>>();

  // Clean up stale buffer files (>24h) on startup
  if (fs.existsSync(bufferDir)) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(bufferDir)) {
      const filePath = path.join(bufferDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        logger.debug('daemon', 'Cleaned stale buffer', { file });
      }
    }
  }

  // Migrate flat memory files into type subdirectories
  const migrated = migrateMemoryFiles(vaultDir);
  if (migrated > 0) {
    logger.info('daemon', 'Migrated memory files to type subdirectories', { count: migrated });
    // Rebuild FTS index to update stored paths (vectors are keyed by ID, unaffected)
    initFts(index);
    rebuildIndex(index, vaultDir);
  }

  // Route body schemas
  const RegisterBody = z.object({
    session_id: z.string(),
    branch: z.string().optional(),
    started_at: z.string().optional(),
  });
  const UnregisterBody = z.object({ session_id: z.string() });
  const EventBody = z.object({ type: z.string(), session_id: z.string() }).passthrough();
  const StopBody = z.object({ session_id: z.string(), user: z.string().optional() });
  const ContextBody = z.object({
    session_id: z.string().optional(),
    branch: z.string().optional(),
    files: z.array(z.string()).optional(),
  });

  const planWatcher = new PlanWatcher({
    projectRoot: process.cwd(),
    watchPaths: config.capture.artifact_watch,
    onPlan: (event) => {
      logger.info('watcher', 'Plan detected', { source: event.source, file: event.filePath });

      if (event.filePath) {
        try {
          const content = fs.readFileSync(event.filePath, 'utf-8');
          const relativePath = path.relative(vaultDir, event.filePath);
          const title = content.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(event.filePath);
          const planId = `plan-${path.basename(event.filePath, '.md')}`;
          indexAndEmbed(relativePath, planId, `${title}\n${content}`, { type: 'plan' },
            indexDeps);
          logger.info('watcher', 'Plan indexed', { path: relativePath });
        } catch (err) {
          logger.debug('watcher', 'Plan index failed', { error: (err as Error).message });
        }
      }
    },
  });
  planWatcher.startFileWatcher();

  const batchManager = new BatchManager(async (closedBatch: BatchEvent[]) => {
    if (closedBatch.length === 0) return;

    const sessionId = closedBatch[0].session_id;

    // Extract observations from this batch
    const asRecords = closedBatch as Array<Record<string, unknown>>;
    const result = await processor.process(asRecords, sessionId);

    if (!result.degraded) {
      writeObservations(result.observations, sessionId, { vault, ...indexDeps });
    }

    logger.debug('processor', 'Batch processed', {
      session_id: sessionId,
      events: closedBatch.length,
      observations: result.observations.length,
      degraded: result.degraded,
    });
  });

  // Session routes
  server.registerRoute('POST', '/sessions/register', async (body: unknown) => {
    const { session_id, branch, started_at } = RegisterBody.parse(body);
    const resolvedStartedAt = started_at ?? new Date().toISOString();
    registry.register(session_id, { started_at: resolvedStartedAt, branch });
    server.updateDaemonJsonSessions(registry.sessions);

    // Heuristic lineage detection
    try {
      const recentSessions = index.query({ type: 'session', limit: 5 })
        .map((n) => {
          const fm = n.frontmatter as Record<string, unknown>;
          return { id: bareSessionId(n.id), ended: fm.ended as string | undefined, branch: fm.branch as string | undefined };
        });
      const activeSessions = registry.sessions
        .filter((s) => s !== session_id)
        .map((s) => registry.getSession(s))
        .filter((s): s is RegisteredSession => s !== undefined);
      const link = lineageGraph.detectHeuristicParent(session_id, {
        started_at: resolvedStartedAt,
        branch,
      }, recentSessions, activeSessions);
      if (link) {
        logger.info('lineage', 'Heuristic parent detected', { child: session_id, parent: link.parent, signal: link.signal });
      }
    } catch (err) {
      logger.debug('lineage', 'Heuristic detection failed', { error: (err as Error).message });
    }

    logger.info('lifecycle', 'Session registered', { session_id, branch });
    return { ok: true, sessions: registry.sessions };
  });

  server.registerRoute('POST', '/sessions/unregister', async (body: unknown) => {
    const { session_id } = UnregisterBody.parse(body);
    registry.unregister(session_id);
    // Note: we do NOT delete buffer FILES on disk. Session reload (SessionEnd → SessionStart)
    // reuses the same session_id, and deleting would wipe all prior events.
    // Buffer files are cleaned up by age during daemon startup.
    // We DO prune the in-memory Map entries to avoid unbounded growth.
    sessionBuffers.delete(session_id);
    sessionFilePaths.delete(session_id);
    server.updateDaemonJsonSessions(registry.sessions);
    logger.info('lifecycle', 'Session unregistered', { session_id });
    return { ok: true, sessions: registry.sessions };
  });

  // Event routes
  server.registerRoute('POST', '/events', async (body: unknown) => {
    const validated = EventBody.parse(body);
    const event = { ...validated, timestamp: validated.timestamp ?? new Date().toISOString() } as BatchEvent;
    logger.debug('hooks', 'Event received', { type: event.type, session_id: event.session_id });

    // Persist to disk so events survive daemon restarts
    if (!sessionBuffers.has(event.session_id)) {
      sessionBuffers.set(event.session_id, new EventBuffer(bufferDir, event.session_id));
    }
    sessionBuffers.get(event.session_id)!.append(event as Record<string, unknown>);

    batchManager.addEvent(event);
    if (validated.type === 'tool_use') {
      const v = validated as Record<string, unknown>;
      planWatcher.checkToolEvent({ tool_name: String(v.tool_name ?? ''), tool_input: v.tool_input, session_id: validated.session_id });
      const toolName = String(v.tool_name ?? '');
      if (toolName === 'Write' || toolName === 'Edit') {
        const filePath = (v.tool_input as Record<string, unknown> | undefined)?.file_path as string | undefined;
        if (filePath) {
          if (!sessionFilePaths.has(event.session_id)) {
            sessionFilePaths.set(event.session_id, new Set());
          }
          sessionFilePaths.get(event.session_id)!.add(filePath);
        }
      }
    }
    return { ok: true };
  });

  server.registerRoute('POST', '/events/stop', async (body: unknown) => {
    const { session_id: sessionId, user } = StopBody.parse(body);
    const sessionMeta = registry.getSession(sessionId);
    logger.info('hooks', 'Stop received', { session_id: sessionId });

    // Mine the last AI response from the transcript and inject as an event.
    // This keeps transcript mining in the daemon (authority) rather than the hook.
    try {
      const aiResponse = transcriptMiner.getLastAssistantResponse(sessionId);
      if (aiResponse) {
        batchManager.addEvent({
          type: 'ai_response',
          content: aiResponse,
          session_id: sessionId,
          timestamp: new Date().toISOString(),
        } as BatchEvent);
      }
    } catch (err) {
      logger.debug('hooks', 'Transcript mining failed', { session_id: sessionId, error: (err as Error).message });
    }

    // Finalize the last open batch and process it
    const lastBatch = batchManager.finalize(sessionId);

    if (lastBatch.length > 0) {
      const asRecords = lastBatch as Array<Record<string, unknown>>;
      const result = await processor.process(asRecords, sessionId);

      if (!result.degraded) {
        writeObservations(result.observations, sessionId, { vault, ...indexDeps });
      }
    }

    // --- Artifact capture (runs concurrently with session building below) ---
    const writtenFiles = sessionFilePaths.get(sessionId) ?? new Set<string>();
    const artifactCandidates = collectArtifactCandidates(
      writtenFiles,
      { artifact_extensions: config.capture.artifact_extensions },
      process.cwd(),
    );

    const artifactPromise = artifactCandidates.length > 0
      ? processor.classifyArtifacts(artifactCandidates, sessionId)
          .then((classified) => captureArtifacts(artifactCandidates, classified, sessionId, { vault, ...indexDeps }))
          .catch((err) => logger.warn('processor', 'Artifact capture failed', { session_id: sessionId, error: (err as Error).message }))
      : Promise.resolve();

    // Build the new turn from this batch
    const batchTurns = extractTurns(lastBatch);
    const ended = new Date().toISOString();
    let started = lastBatch.length > 0 ? String(lastBatch[0].timestamp) : ended;

    // Find existing session file — may be in a different date directory if session spans days.
    // Search by session ID across all date directories to avoid creating duplicates.
    const date = started.slice(0, 10);
    const relativePath = sessionRelativePath(sessionId, date);
    const targetFullPath = path.join(vaultDir, relativePath);

    let existingContent: string | undefined;
    const sessionsDir = path.join(vaultDir, 'sessions');
    try {
      for (const dateDir of fs.readdirSync(sessionsDir)) {
        const candidate = path.join(sessionsDir, dateDir, `${sessionNoteId(sessionId)}.md`);
        if (fs.existsSync(candidate)) {
          existingContent = fs.readFileSync(candidate, 'utf-8');
          // If the file is in a different date dir, remove the old copy to avoid duplicates
          if (candidate !== targetFullPath) {
            fs.unlinkSync(candidate);
          }
          break;
        }
      }
    } catch { /* sessions dir may not exist yet */ }

    let existingTurnCount = 0;
    let existingConversation: string | undefined;
    if (existingContent) {
      // Count existing turns
      const turnMatches = existingContent.match(/^### Turn \d+/gm);
      existingTurnCount = turnMatches?.length ?? 0;
      // Extract started from frontmatter (preserves original start time)
      const startedMatch = existingContent.match(/^started:\s*"?(.+?)"?\s*$/m);
      if (startedMatch) started = startedMatch[1];
      // Extract existing conversation section to preserve prior turns
      const bodyStart = existingContent.indexOf('---', 3);
      const body = bodyStart >= 0 ? existingContent.slice(bodyStart + 3).replace(/^\n+/, '') : existingContent;
      const convIdx = body.indexOf('## Conversation');
      if (convIdx >= 0) {
        existingConversation = body.slice(convIdx).replace(/\n+$/, '');
      }
    }

    // Build the full conversation for re-summarization (existing + new turns as plain text)
    const newTurnText = batchTurns.map((t, i) => {
      const num = existingTurnCount + i + 1;
      const parts = [`### Turn ${num}`];
      if (t.prompt) parts.push(`Prompt: ${t.prompt}`);
      if (t.toolCount > 0) parts.push(`Tools: ${t.toolCount} calls`);
      if (t.aiResponse) parts.push(`Response: ${t.aiResponse}`);
      return parts.join('\n');
    }).join('\n\n');
    const conversationSection = existingConversation
      ? `${existingConversation}\n\n${newTurnText}`
      : `## Conversation\n\n${newTurnText}`;

    // Re-summarize the full session from the complete conversation
    let title = `Session ${sessionId}`;
    let narrative = '';
    try {
      const result = await processor.summarizeSession(conversationSection, sessionId, user);
      narrative = result.summary;
      title = result.title;
    } catch (err) {
      logger.warn('processor', 'Session summarization failed', { session_id: sessionId, error: (err as Error).message });
    }

    // Query related memories for this session
    const relatedMemories = index.query({ type: 'memory', limit: 50 })
      .filter((n) => {
        const fm = n.frontmatter as Record<string, unknown>;
        return fm.session === sessionNoteId(sessionId) || fm.session === sessionId;
      })
      .map((n) => ({ id: n.id, title: n.title }));

    const summary = formatSessionBody({
      title,
      narrative,
      sessionId,
      user,
      started,
      ended,
      relatedMemories,
      turns: batchTurns.map((t) => ({ prompt: t.prompt, toolCount: t.toolCount, aiResponse: t.aiResponse })),
      existingTurnCount,
      existingConversation,
    });

    const parentId = lineageGraph.getParent(sessionId);
    const parentLink = parentId ? lineageGraph.getLinks().find((l) => l.child === sessionId) : undefined;

    vault.writeSession({
      id: sessionId,
      user,
      started,
      ended,
      branch: sessionMeta?.branch,
      parent: parentId ? sessionWikilink(parentId) : undefined,
      parent_reason: parentLink?.signal,
      tools_used: batchTurns.reduce((sum, t) => sum + t.toolCount, 0),
      summary,
    });
    indexAndEmbed(relativePath, sessionNoteId(sessionId), narrative,
      { type: 'session', session_id: sessionId }, indexDeps);

    // Wait for artifact capture (started concurrently with session building)
    await artifactPromise;

    // Phase 2: LLM similarity detection (fire-and-forget, only if no heuristic parent)
    if (!parentId && vectorIndex && narrative) {
      generateEmbedding(embeddingProvider, narrative)
        .then(async (emb) => {
          const candidates = vectorIndex!.search(emb.embedding, { limit: LINEAGE_SIMILARITY_CANDIDATES })
            .filter((r) => r.metadata.type === 'session' && r.id !== sessionNoteId(sessionId));
          if (candidates.length === 0) return;

          // Score all candidates in parallel
          const candidateNotes = index.queryByIds(candidates.map((c) => c.id));
          const noteMap = new Map(candidateNotes.map((n) => [n.id, n]));

          const scores = await Promise.all(candidates.map(async (candidate) => {
            const note = noteMap.get(candidate.id);
            if (!note) return { id: candidate.id, score: 0 };
            try {
              const prompt = buildSimilarityPrompt(narrative, note.content.slice(0, CANDIDATE_CONTENT_PREVIEW));
              const response = await llmProvider.summarize(prompt, { maxTokens: LINEAGE_SIMILARITY_MAX_TOKENS });
              const score = parseFloat(response.text.trim());
              return { id: candidate.id, score: isNaN(score) ? 0 : score };
            } catch { return { id: candidate.id, score: 0 }; }
          }));

          const best = scores.reduce((a, b) => (b.score > a.score ? b : a));

          if (best.score >= LINEAGE_SIMILARITY_THRESHOLD) {
            const bestParentId = bareSessionId(best.id);
            const confidence: LineageLink['confidence'] = best.score >= LINEAGE_SIMILARITY_HIGH_CONFIDENCE ? 'high' : 'medium';
            lineageGraph.addLink({
              parent: bestParentId,
              child: sessionId,
              signal: 'semantic_similarity',
              confidence: confidence as 'high' | 'medium',
            });
            // Retroactively update session frontmatter with parent
            try {
              vault.updateSessionFrontmatter(relativePath, {
                parent: sessionWikilink(bestParentId),
                parent_reason: 'semantic_similarity',
              });
            } catch { /* frontmatter update failed — link still in lineage.json */ }
            logger.info('lineage', 'LLM similarity parent detected', {
              child: sessionId, parent: bestParentId, score: best.score,
            });
          }
        })
        .catch((err) => logger.debug('lineage', 'Similarity detection failed', { error: (err as Error).message }));
    }

    logger.info('processor', 'Session note written', { session_id: sessionId, path: relativePath });
    return { ok: true, path: relativePath };
  });

  server.registerRoute('POST', '/context', async (body: unknown) => {
    const { session_id, branch, files } = ContextBody.parse(body);
    logger.debug('hooks', 'Context query', { session_id });
    try {
      if (vectorIndex && branch) {
        const queryText = `branch: ${branch} files: ${(files ?? []).join(' ')}`;
        const emb = await generateEmbedding(embeddingProvider, queryText);
        const results = vectorIndex.search(emb.embedding, {
          limit: 10,
        });
        if (results.length > 0) {
          // Batch-fetch all notes in one query instead of N+1
          const noteMap = new Map(
            index.queryByIds(results.map((r) => r.id)).map((n) => [n.id, n]),
          );
          const parts: string[] = [];
          let budget = config.context.max_tokens;
          const sorted = results.sort((a, b) => {
            const imp = { high: 0, medium: 1, low: 2 } as Record<string, number>;
            return (imp[a.metadata.importance] ?? 1) - (imp[b.metadata.importance] ?? 1) || b.similarity - a.similarity;
          });
          for (const r of sorted) {
            const note = noteMap.get(r.id);
            if (!note) continue;
            const snippet = `- **${note.title}** (${r.metadata.type}): ${note.content.slice(0, 120)}`;
            const tokens = Math.ceil(snippet.length / 4);
            if (tokens > budget) break;
            parts.push(snippet);
            budget -= tokens;
          }
          if (parts.length > 0) return { text: `### Myco Context\n${parts.join('\n')}` };
        }
      }
      const injected = buildInjectedContext(index, config, { branch, files });
      return { text: injected.text };
    } catch (error) {
      logger.error('daemon', 'Context query failed', { error: (error as Error).message });
      return { text: '' };
    }
  });

  await server.start();
  logger.info('daemon', 'Daemon ready', { vault: vaultDir, port: server.port });

  const shutdown = async (signal: string) => {
    logger.info('daemon', `${signal} received`);
    planWatcher.stopFileWatcher();
    registry.destroy();
    await server.stop();
    vectorIndex?.close();
    index.close();
    logger.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Entry point guard — only run when executed directly, not when imported in tests
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch((err) => {
    process.stderr.write(`[mycod] Fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
