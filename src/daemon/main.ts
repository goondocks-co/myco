import { DaemonServer } from './server.js';
import { SessionRegistry } from './lifecycle.js';
import { DaemonLogger } from './logger.js';
import { loadConfig, saveConfig } from '../config/loader.js';
import { BatchManager, type BatchEvent } from './batch.js';
import { BufferProcessor, type Observation, type ClassifiedArtifact } from './processor.js';
import { VaultWriter } from '../vault/writer.js';
import { MycoIndex } from '../index/sqlite.js';
import { indexNote, rebuildIndex } from '../index/rebuild.js';
import { initFts } from '../index/fts.js';
import { createLlmProvider, createEmbeddingProvider } from '../intelligence/llm.js';
import type { EmbeddingProvider, LlmProvider } from '../intelligence/llm.js';
import { VectorIndex } from '../index/vectors.js';
import { generateEmbedding } from '../intelligence/embeddings.js';
import { LineageGraph, LINEAGE_SIMILARITY_THRESHOLD, LINEAGE_SIMILARITY_HIGH_CONFIDENCE, LINEAGE_SIMILARITY_CANDIDATES, LINEAGE_SIMILARITY_MAX_TOKENS, type LineageLink } from './lineage.js';
import type { RegisteredSession } from './lifecycle.js';
import { PlanWatcher } from './watcher.js';
import { DigestEngine, Metabolism } from './digest.js';
import { resolvePort } from './port.js';
import { handleMycoContext } from '../mcp/tools/context.js';
import { buildSimilarityPrompt } from '../prompts/index.js';
import { extractNumber } from '../intelligence/response.js';
import { EMBEDDING_INPUT_LIMIT, CONTENT_SNIPPET_CHARS, CHARS_PER_TOKEN, STALE_BUFFER_MAX_AGE_MS, LINEAGE_RECENT_SESSIONS_LIMIT, RELATED_SPORES_LIMIT, CANDIDATE_CONTENT_PREVIEW, SESSION_CONTEXT_MAX_PLANS, PROMPT_CONTEXT_MAX_SPORES, PROMPT_CONTEXT_MIN_SIMILARITY, PROMPT_CONTEXT_MIN_LENGTH, CONTEXT_SESSION_PREVIEW_CHARS, LLM_REASONING_MODE } from '../constants.js';
import { TranscriptMiner, extractTurnsFromBuffer } from '../capture/transcript-miner.js';
import { createPerProjectAdapter, extensionForMimeType } from '../agents/adapter.js';
import { claudeCodeAdapter } from '../agents/claude-code.js';
import { EventBuffer } from '../capture/buffer.js';
import { formatSessionBody } from '../obsidian/formatter.js';
import { writeObservationNotes } from '../vault/observations.js';
import { checkSupersession } from '../vault/curation.js';
import { collectArtifactCandidates } from '../artifacts/candidates.js';
import { slugifyPath } from '../artifacts/slugify.js';
import { sessionNoteId, bareSessionId, sessionWikilink, sessionRelativePath } from '../vault/session-id.js';
import { z } from 'zod';
import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';


interface IndexDeps {
  index: MycoIndex;
  vaultDir: string;
  vectorIndex: VectorIndex | null;
  embeddingProvider: EmbeddingProvider;
  llmProvider: LlmProvider;
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
    generateEmbedding(deps.embeddingProvider, embeddingText.slice(0, EMBEDDING_INPUT_LIMIT))
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
      { type: 'spore', importance: 'high', session_id: sessionId }, deps);
    deps.logger.info('processor', 'Observation written', { type: note.observation.type, title: note.observation.title, session_id: sessionId });
  }

  // Fire-and-forget supersession checks — sequential to avoid thundering herd on the LLM
  if (written.length > 0) {
    const curationDeps = {
      index: deps.index,
      vectorIndex: deps.vectorIndex,
      embeddingProvider: deps.embeddingProvider,
      llmProvider: deps.llmProvider,
      vaultDir: deps.vaultDir,
      log: ((level: string, msg: string, data?: Record<string, unknown>) => (deps.logger as any)[level]('curation', msg, data)) as Parameters<typeof checkSupersession>[1]['log'],
    };
    (async () => {
      for (const note of written) {
        try { await checkSupersession(note.id, curationDeps); }
        catch (err) { deps.logger.debug('curation', 'Supersession check failed', { id: note.id, error: (err as Error).message }); }
      }
    })();
  }
}

async function captureArtifacts(
  candidates: Array<{ path: string; content: string }>,
  classified: ClassifiedArtifact[],
  sessionId: string,
  deps: IndexDeps & { vault: VaultWriter },
  lineage?: LineageGraph,
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

    // Register artifact-session association for lineage detection.
    // Future sessions referencing this artifact ID link as children.
    lineage?.registerArtifactForSession(sessionId, artifactId);
  }
}

export function migrateSporeFiles(vaultDir: string): number {
  const sporesDir = path.join(vaultDir, 'spores');
  if (!fs.existsSync(sporesDir)) return 0;

  let moved = 0;
  const entries = fs.readdirSync(sporesDir);

  for (const entry of entries) {
    const fullPath = path.join(sporesDir, entry);
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
      const targetDir = path.join(sporesDir, normalizedType);
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

export async function main(): Promise<void> {
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

  // Resolve dist/ui/ relative to this daemon script's location
  const scriptDir = new URL('.', import.meta.url).pathname;
  const uiDirPath = path.resolve(scriptDir, '..', '..', 'ui');
  const uiDir = fs.existsSync(uiDirPath) ? uiDirPath : null;
  if (uiDir) {
    logger.debug('daemon', 'Static UI directory found', { path: uiDir });
  }

  const server = new DaemonServer({ vaultDir, logger, uiDir: uiDir ?? undefined });

  const registry = new SessionRegistry({
    gracePeriod: config.daemon.grace_period,
    onEmpty: async () => {
      logger.info('daemon', 'Grace period expired, shutting down');
      metabolism?.stop();
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

  const processor = new BufferProcessor(llmProvider, config.intelligence.llm.context_window, config.capture);
  const vault = new VaultWriter(vaultDir);
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));
  const lineageGraph = new LineageGraph(vaultDir);
  const transcriptMiner = new TranscriptMiner({
    additionalAdapters: config.capture.transcript_paths.map((p) =>
      createPerProjectAdapter(p, claudeCodeAdapter.parseTurns),
    ),
  });

  let activeStopProcessing: Promise<void> | null = null;
  const indexDeps: IndexDeps = { index, vaultDir, vectorIndex, embeddingProvider, llmProvider, logger };

  const bufferDir = path.join(vaultDir, 'buffer');
  const sessionBuffers = new Map<string, EventBuffer>();
  const sessionFilePaths = new Map<string, Set<string>>();
  const capturedArtifactPaths = new Map<string, Set<string>>();

  // Clean up stale buffer files (>24h) on startup
  if (fs.existsSync(bufferDir)) {
    const cutoff = Date.now() - STALE_BUFFER_MAX_AGE_MS;
    for (const file of fs.readdirSync(bufferDir)) {
      const filePath = path.join(bufferDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        logger.debug('daemon', 'Cleaned stale buffer', { file });
      }
    }
  }

  // Check for stale 'memory' type entries — migration happened but index wasn't rebuilt.
  // Deferred to after server starts so it doesn't block the health check.
  const needsMigrationReindex = index.query({ type: 'memory' }).length > 0;

  // Migrate flat spore files into type subdirectories
  const migrated = migrateSporeFiles(vaultDir);
  if (migrated > 0) {
    logger.info('daemon', 'Migrated spore files to type subdirectories', { count: migrated });
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
  const StopBody = z.object({
    session_id: z.string(),
    user: z.string().optional(),
    transcript_path: z.string().optional(),
    last_assistant_message: z.string().optional(),
  });
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

          // Register plan-session association for lineage detection.
          // When a future session's first prompt mentions this plan ID,
          // detectHeuristicParent links it as a child of this session.
          if (event.sessionId) {
            lineageGraph.registerArtifactForSession(event.sessionId, planId);
            logger.debug('lineage', 'Plan registered for session', { planId, session: event.sessionId });
          }

          logger.info('watcher', 'Plan indexed', { path: relativePath });
        } catch (err) {
          logger.debug('watcher', 'Plan index failed', { error: (err as Error).message });
        }
      }
    },
  });
  planWatcher.startFileWatcher();

  // Digest engine: synthesizes vault knowledge into tiered context extracts
  let metabolism: Metabolism | null = null;

  if (config.digest.enabled) {
    const digestLlmConfig = {
      provider: config.digest.intelligence.provider ?? config.intelligence.llm.provider,
      model: config.digest.intelligence.model ?? config.intelligence.llm.model,
      base_url: config.digest.intelligence.base_url ?? config.intelligence.llm.base_url,
      context_window: config.digest.intelligence.context_window,
    };
    logger.debug('digest', 'Digest LLM config', digestLlmConfig);
    const digestLlm = (config.digest.intelligence.model || config.digest.intelligence.provider)
      ? createLlmProvider(digestLlmConfig)
      : llmProvider;
    logger.debug('digest', `Using ${digestLlm.name} provider for digest`);

    const digestEngine = new DigestEngine({
      vaultDir,
      index,
      llmProvider: digestLlm,
      config,
      log: (level, message, data) => logger[level]('digest', message, data),
    });

    metabolism = new Metabolism(config.digest.metabolism);

    // Fire initial cycle in the background — don't block server readiness
    logger.debug('digest', 'Firing initial digest cycle (background)');
    digestEngine.runCycle()
      .then((result) => {
        if (result) {
          metabolism!.onSubstrateFound();
          logger.info('digest', `Initial digest cycle: ${result.tiersGenerated.length} tiers, ${result.durationMs}ms`);
        }
      })
      .catch((err) => {
        logger.warn('digest', 'Initial digest cycle failed', { error: (err as Error).message });
        metabolism!.onEmptyCycle();
      });

    // Start metabolism timer
    metabolism.start(async () => {
      try {
        const cycleResult = await digestEngine.runCycle();
        if (cycleResult) {
          metabolism!.onSubstrateFound();
          logger.info('digest', `Digest cycle ${cycleResult.cycleId}: ${cycleResult.tiersGenerated.length} tiers`);
        } else {
          metabolism!.onEmptyCycle();
          logger.debug('digest', 'No substrate, backing off');
        }
      } catch (err) {
        logger.warn('digest', 'Digest cycle failed', { error: (err as Error).message });
        metabolism!.onEmptyCycle();
      }
    });

    logger.info('digest', 'Digest enabled — starting metabolism');
  }

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

    // Incremental artifact capture: process new markdown files at turn boundaries
    // instead of waiting for session end. Only classify files not yet captured.
    const allPaths = sessionFilePaths.get(sessionId);
    const alreadyCaptured = capturedArtifactPaths.get(sessionId) ?? new Set<string>();
    if (allPaths && allPaths.size > alreadyCaptured.size) {
      const newPaths = new Set([...allPaths].filter((p) => !alreadyCaptured.has(p)));
      const candidates = collectArtifactCandidates(
        newPaths,
        { artifact_extensions: config.capture.artifact_extensions },
        process.cwd(),
      );
      if (candidates.length > 0) {
        processor.classifyArtifacts(candidates, sessionId)
          .then((classified) => captureArtifacts(candidates, classified, sessionId, { vault, ...indexDeps }, lineageGraph))
          .then(() => {
            // Mark these paths as captured so we don't re-classify them
            if (!capturedArtifactPaths.has(sessionId)) {
              capturedArtifactPaths.set(sessionId, new Set());
            }
            const captured = capturedArtifactPaths.get(sessionId)!;
            for (const c of candidates) {
              // candidates have relative paths; sessionFilePaths has absolute paths
              const absPath = path.resolve(process.cwd(), c.path);
              captured.add(absPath);
            }
          })
          .catch((err) => logger.warn('processor', 'Incremental artifact capture failed', {
            session_id: sessionId, error: (err as Error).message,
          }));
      }
    }
  });

  // Session routes
  server.registerRoute('POST', '/sessions/register', async (req) => {
    const { session_id, branch, started_at } = RegisterBody.parse(req.body);
    const resolvedStartedAt = started_at ?? new Date().toISOString();
    registry.register(session_id, { started_at: resolvedStartedAt, branch });
    server.updateDaemonJsonSessions(registry.sessions);

    // Heuristic lineage detection
    try {
      const recentSessions = index.query({ type: 'session', limit: LINEAGE_RECENT_SESSIONS_LIMIT })
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

    // Wake digest metabolism when a new session starts
    metabolism?.activate();

    logger.info('lifecycle', 'Session registered', { session_id, branch });
    return { body: { ok: true, sessions: registry.sessions } };
  });

  server.registerRoute('POST', '/sessions/unregister', async (req) => {
    const { session_id } = UnregisterBody.parse(req.body);
    registry.unregister(session_id);
    // Note: we do NOT delete the buffer FILE for THIS session. Session reload
    // (SessionEnd → SessionStart) reuses the same session_id, and deleting
    // would wipe all prior events.
    // We DO opportunistically clean stale buffers for OTHER sessions (>24h).
    try {
      const cutoff = Date.now() - STALE_BUFFER_MAX_AGE_MS;
      for (const file of fs.readdirSync(bufferDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const bufferSessionId = file.replace('.jsonl', '');
        if (bufferSessionId === session_id) continue; // skip current session
        const filePath = path.join(bufferDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          logger.debug('daemon', 'Cleaned stale buffer', { file });
        }
      }
    } catch { /* buffer dir may not exist */ }
    // We DO prune the in-memory Map entries to avoid unbounded growth.
    sessionBuffers.delete(session_id);
    sessionFilePaths.delete(session_id);
    capturedArtifactPaths.delete(session_id);
    server.updateDaemonJsonSessions(registry.sessions);
    logger.info('lifecycle', 'Session unregistered', { session_id });
    return { body: { ok: true, sessions: registry.sessions } };
  });

  // Event routes
  server.registerRoute('POST', '/events', async (req) => {
    const validated = EventBody.parse(req.body);
    const event = { ...validated, timestamp: validated.timestamp ?? new Date().toISOString() } as BatchEvent;
    logger.debug('hooks', 'Event received', { type: event.type, session_id: event.session_id });

    // Ensure session is registered (idempotent — handles daemon restarts mid-session)
    if (!registry.getSession(event.session_id)) {
      registry.register(event.session_id, { started_at: event.timestamp });
      logger.debug('lifecycle', 'Auto-registered session from event', { session_id: event.session_id });
    }

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
          // Invalidate captured status so edits to already-captured files
          // trigger re-classification on the next turn boundary
          capturedArtifactPaths.get(event.session_id)?.delete(filePath);
        }
      }
    }
    return { body: { ok: true } };
  });

  server.registerRoute('POST', '/events/stop', async (req) => {
    const { session_id: sessionId, user, transcript_path: hookTranscriptPath, last_assistant_message: lastAssistantMessage } = StopBody.parse(req.body);
    // Ensure session is registered (handles daemon restarts mid-session)
    if (!registry.getSession(sessionId)) {
      registry.register(sessionId, { started_at: new Date().toISOString() });
      logger.debug('lifecycle', 'Auto-registered session from stop event', { session_id: sessionId });
    }
    const sessionMeta = registry.getSession(sessionId);
    logger.info('hooks', 'Stop received', { session_id: sessionId, has_transcript_path: !!hookTranscriptPath, has_response: !!lastAssistantMessage });

    // Respond immediately — the hook should not block on LLM processing.
    // Serialize stop processing: if a previous stop is still running, chain
    // the new one to run after it completes. This prevents concurrent
    // processStopEvent calls from racing on the same session file.
    const run = () => processStopEvent(sessionId, user, sessionMeta, hookTranscriptPath, lastAssistantMessage).catch((err) => {
      logger.error('processor', 'Stop processing failed', { session_id: sessionId, error: (err as Error).message });
    });

    // Chain onto any in-flight processing. Only the tail of the chain clears the variable.
    const prev = activeStopProcessing ?? Promise.resolve();
    activeStopProcessing = prev.then(run).finally(() => { activeStopProcessing = null; });

    return { body: { ok: true } };
  });

  async function processStopEvent(
    sessionId: string,
    user: string | undefined,
    sessionMeta: RegisteredSession | undefined,
    hookTranscriptPath?: string,
    lastAssistantMessage?: string,
  ): Promise<void> {

    // --- Phase 1: Gather data (I/O only, no LLM) ---

    const lastBatch = batchManager.finalize(sessionId);

    // Tiered turn extraction:
    // 1. Read transcript for complete turns (with AI responses)
    // 2. Check buffer for prompts newer than the transcript's last turn
    //    (captures turns the transcript missed, e.g., after context compaction)
    // 3. Fall back to buffer entirely if no transcript found
    const transcriptResult = transcriptMiner.getAllTurnsWithSource(sessionId, hookTranscriptPath);
    let allTurns = transcriptResult.turns;
    let turnSource = transcriptResult.source;

    const bufferEvents = sessionBuffers.get(sessionId)?.readAll() ?? [];

    if (allTurns.length === 0) {
      // No transcript — use buffer as primary source
      allTurns = extractTurnsFromBuffer(bufferEvents);
      turnSource = 'buffer';
    } else if (bufferEvents.length > 0) {
      // Transcript exists — check for buffer events newer than the last transcript turn.
      // These are prompts the transcript missed (e.g., after context compaction).
      const lastTranscriptTs = allTurns[allTurns.length - 1].timestamp;
      if (lastTranscriptTs) {
        const newerEvents = bufferEvents.filter((e) =>
          String(e.timestamp ?? '') > lastTranscriptTs,
        );
        if (newerEvents.length > 0) {
          const bufferTurns = extractTurnsFromBuffer(newerEvents);
          allTurns = [...allTurns, ...bufferTurns];
          turnSource = `${transcriptResult.source}+buffer`;
          logger.info('processor', 'Appended buffer turns missing from transcript', {
            session_id: sessionId, transcriptTurns: transcriptResult.turns.length, bufferTurns: bufferTurns.length,
          });
        }
      }
    }

    // Attach the last assistant message from the hook to the most recent turn
    // that doesn't already have an AI response. This captures the response
    // for turns the transcript missed (post-compaction) or buffer-sourced turns.
    if (lastAssistantMessage && allTurns.length > 0) {
      const lastTurn = allTurns[allTurns.length - 1];
      if (!lastTurn.aiResponse) {
        lastTurn.aiResponse = lastAssistantMessage;
      }
    }

    const ended = new Date().toISOString();
    let started = (allTurns.length > 0 && allTurns[0].timestamp) ? allTurns[0].timestamp : ended;

    // Find existing session file and clean up cross-date duplicates in one pass.
    const sessionsDir = path.join(vaultDir, 'sessions');
    const sessionFileName = `${sessionNoteId(sessionId)}.md`;
    let existingContent: string | undefined;
    const duplicatePaths: string[] = [];
    try {
      for (const dateDir of fs.readdirSync(sessionsDir)) {
        const candidate = path.join(sessionsDir, dateDir, sessionFileName);
        try {
          const content = fs.readFileSync(candidate, 'utf-8');
          if (!existingContent || content.length > existingContent.length) {
            existingContent = content;
          }
          duplicatePaths.push(candidate);
        } catch { /* file doesn't exist in this date dir */ }
      }
    } catch { /* sessions dir may not exist yet */ }

    let existingTurnCount = 0;
    if (existingContent) {
      const fmMatch = existingContent.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const parsed = YAML.parse(fmMatch[1]) as Record<string, unknown>;
        if (typeof parsed.started === 'string') started = parsed.started;
      }
      const turnMatches = existingContent.match(/^### Turn \d+/gm);
      existingTurnCount = turnMatches?.length ?? 0;
    }

    // Collect artifact candidates (no LLM yet) — only files not already captured incrementally
    const writtenFiles = sessionFilePaths.get(sessionId) ?? new Set<string>();
    const alreadyCaptured = capturedArtifactPaths.get(sessionId) ?? new Set<string>();
    const uncapturedFiles = new Set([...writtenFiles].filter((p) => !alreadyCaptured.has(p)));
    const artifactCandidates = collectArtifactCandidates(
      uncapturedFiles,
      { artifact_extensions: config.capture.artifact_extensions },
      process.cwd(),
    );

    // Guard: never overwrite an existing session with zero turns — the transcript
    // is temporarily unreadable (daemon restart, file locked, etc.)
    if (allTurns.length === 0 && existingTurnCount > 0) {
      logger.warn('processor', 'Transcript unreadable, skipping rewrite to preserve existing data', { session_id: sessionId, existingTurns: existingTurnCount });
      return;
    }

    // Skip if no new turns AND no batch to process AND no artifacts to classify
    if (allTurns.length > 0 && allTurns.length === existingTurnCount && lastBatch.length === 0 && artifactCandidates.length === 0) {
      logger.debug('processor', 'No new turns, skipping session rewrite', { session_id: sessionId, turns: allTurns.length });
      return;
    }

    // --- Phase 2: LLM calls in parallel ---

    // Build conversation text for summarization (pure string, no LLM)
    const conversationText = allTurns.map((t, i) => {
      const parts = [`### Turn ${i + 1}`];
      if (t.prompt) parts.push(`Prompt: ${t.prompt}`);
      if (t.toolCount > 0) parts.push(`Tools: ${t.toolCount} calls`);
      if (t.aiResponse) parts.push(`Response: ${t.aiResponse}`);
      return parts.join('\n');
    }).join('\n\n');
    const conversationSection = `## Conversation\n\n${conversationText}`;

    // Launch all LLM calls concurrently
    const observationPromise = lastBatch.length > 0
      ? processor.process(lastBatch as Array<Record<string, unknown>>, sessionId)
          .catch((err) => { logger.warn('processor', 'Observation extraction failed', { session_id: sessionId, error: (err as Error).message }); return null; })
      : Promise.resolve(null);

    const artifactPromise = artifactCandidates.length > 0
      ? processor.classifyArtifacts(artifactCandidates, sessionId)
          .then((classified) => captureArtifacts(artifactCandidates, classified, sessionId, { vault, ...indexDeps }, lineageGraph))
          .catch((err) => { logger.warn('processor', 'Artifact capture failed', { session_id: sessionId, error: (err as Error).message }); })
      : Promise.resolve();

    const summaryPromise = processor.summarizeSession(conversationSection, sessionId, user)
      .catch((err) => { logger.warn('processor', 'Session summarization failed', { session_id: sessionId, error: (err as Error).message }); return null; });

    // Wait for all LLM calls to complete
    const [observationResult, , summaryResult] = await Promise.all([observationPromise, artifactPromise, summaryPromise]);

    // --- Phase 3: Write results to vault ---

    // Write observations
    if (observationResult && !observationResult.degraded) {
      writeObservations(observationResult.observations, sessionId, { vault, ...indexDeps });
    }

    // Compute canonical path
    const date = started.slice(0, 10);
    const relativePath = sessionRelativePath(sessionId, date);
    const targetFullPath = path.join(vaultDir, relativePath);

    // Remove cross-date duplicates
    for (const dup of duplicatePaths) {
      if (dup !== targetFullPath) {
        try { fs.unlinkSync(dup); logger.debug('lifecycle', 'Removed duplicate session file', { path: dup }); } catch { /* already gone */ }
      }
    }

    // Write images to attachments
    const attachmentsDir = path.join(vaultDir, 'attachments');
    const hasImages = allTurns.some((t) => t.images?.length);
    if (hasImages) {
      fs.mkdirSync(attachmentsDir, { recursive: true });
    }
    const turnImageNames: Map<number, string[]> = new Map();
    for (let i = 0; i < allTurns.length; i++) {
      const turn = allTurns[i];
      if (!turn.images?.length) continue;
      const names: string[] = [];
      for (let j = 0; j < turn.images.length; j++) {
        const img = turn.images[j];
        const ext = extensionForMimeType(img.mediaType);
        const filename = `${bareSessionId(sessionId)}-t${i + 1}-${j + 1}.${ext}`;
        const filePath = path.join(attachmentsDir, filename);
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, Buffer.from(img.data, 'base64'));
          logger.debug('processor', 'Image saved', { filename, turn: i + 1 });
        }
        names.push(filename);
      }
      turnImageNames.set(i, names);
    }

    // Build and write session note
    let title = `Session ${sessionId}`;
    let narrative = '';
    if (summaryResult) {
      title = summaryResult.title;
      narrative = summaryResult.summary;
    }

    // Query related spores for this session
    const relatedMemories = index.query({ type: 'spore', limit: RELATED_SPORES_LIMIT })
      .filter((n) => {
        const fm = n.frontmatter as Record<string, unknown>;
        return fm.session === sessionNoteId(sessionId) || fm.session === sessionId;
      })
      .map((n) => ({ id: n.id, title: n.title }));

    // The formatter always gets the full turn list — no more partial appending.
    // existingConversation is no longer needed; we rebuild from the transcript each time.
    const summary = formatSessionBody({
      title,
      narrative,
      sessionId,
      user,
      started,
      ended,
      branch: sessionMeta?.branch,
      relatedMemories,
      turns: allTurns.map((t, i) => ({
        prompt: t.prompt,
        toolCount: t.toolCount,
        aiResponse: t.aiResponse,
        images: turnImageNames.get(i),
      })),
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
      tools_used: allTurns.reduce((sum, t) => sum + t.toolCount, 0),
      summary,
    });
    indexAndEmbed(relativePath, sessionNoteId(sessionId), narrative,
      { type: 'session', session_id: sessionId }, indexDeps);

    logger.debug('processor', 'Session turns', { source: turnSource, total: allTurns.length });

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
              const response = await llmProvider.summarize(prompt, { maxTokens: LINEAGE_SIMILARITY_MAX_TOKENS, reasoning: LLM_REASONING_MODE });
              const score = extractNumber(response.text);
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
            // Retroactively update session frontmatter with parent + re-index
            try {
              vault.updateNoteFrontmatter(relativePath, {
                parent: sessionWikilink(bestParentId),
                parent_reason: 'semantic_similarity',
              });
              indexNote(index, vaultDir, relativePath);
            } catch { /* frontmatter update failed — link still in lineage.json */ }
            logger.info('lineage', 'LLM similarity parent detected', {
              child: sessionId, parent: bestParentId, score: best.score,
            });
          }
        })
        .catch((err) => logger.debug('lineage', 'Similarity detection failed', { error: (err as Error).message }));
    }

    logger.info('processor', 'Session note written', { session_id: sessionId, path: relativePath });
  }

  // Session-start context: digest extract (if available) or structural facts.
  // Memories are injected per-prompt (more targeted, less noise).
  server.registerRoute('POST', '/context', async (req) => {
    const { session_id, branch } = ContextBody.parse(req.body);
    logger.debug('hooks', 'Session context query', { session_id });
    try {
      // Digest-first: serve pre-computed extract if available
      if (config.digest.enabled && config.digest.inject_tier) {
        const result = handleMycoContext(vaultDir, { tier: config.digest.inject_tier });

        if (result.generated !== undefined) {
          // Append session metadata that the agent needs regardless of context source
          const meta: string[] = [result.content];
          if (branch) meta.push(`\nBranch:: \`${branch}\``);
          meta.push(`Session:: \`${session_id}\``);

          logger.debug('context', `Injecting digest extract (tier ${result.tier})`, { session_id, fallback: result.fallback });
          return { body: { text: meta.join('\n\n'), source: 'digest', tier: result.tier } };
        }
        // Fall through to layer-based injection if no extract exists yet
      }

      const parts: string[] = [];

      // Active plans — the agent needs to know what's in flight
      const plans = index.query({ type: 'plan' });
      const activePlans = plans.filter((p) => {
        const status = (p.frontmatter as Record<string, unknown>).status as string;
        return status === 'active' || status === 'in_progress';
      });
      if (activePlans.length > 0) {
        const planLines = activePlans.slice(0, SESSION_CONTEXT_MAX_PLANS).map((p) => {
          const status = (p.frontmatter as Record<string, unknown>).status as string;
          return `- **${p.title}** (${status}) \`[${p.id}]\``;
        });
        parts.push(`### Active Plans\n${planLines.join('\n')}`);
      }

      // Parent session summary — lineage continuity
      if (session_id) {
        const parentId = lineageGraph.getParent(session_id);
        if (parentId) {
          const parentNotes = index.queryByIds([sessionNoteId(parentId)]);
          if (parentNotes.length > 0) {
            const parent = parentNotes[0];
            parts.push(`### Previous Session\n- **${parent.title}**: ${parent.content.slice(0, CONTEXT_SESSION_PREVIEW_CHARS)} \`[${parent.id}]\``);
          }
        }
      }

      // Branch info for awareness
      if (branch) {
        parts.push(`Branch:: \`${branch}\``);
      }

      // Always include the session ID so the agent can pass it to myco_remember
      parts.push(`Session:: \`${session_id}\``);

      if (parts.length > 0) {
        return { body: { text: parts.join('\n\n') } };
      }
      return { body: { text: '' } };
    } catch (error) {
      logger.error('daemon', 'Session context failed', { error: (error as Error).message });
      return { body: { text: '' } };
    }
  });

  // Per-prompt context: semantic search for spores relevant to THIS specific prompt.
  // This is the primary intelligence delivery — targeted, high-confidence, token-efficient.
  const PromptContextBody = z.object({
    prompt: z.string(),
    session_id: z.string().optional(),
  });

  server.registerRoute('POST', '/context/prompt', async (req) => {
    const { prompt, session_id } = PromptContextBody.parse(req.body);
    if (!prompt || prompt.length < PROMPT_CONTEXT_MIN_LENGTH || !vectorIndex) {
      return { body: { text: '' } };
    }

    try {
      const emb = await generateEmbedding(embeddingProvider, prompt.slice(0, EMBEDDING_INPUT_LIMIT));
      const results = vectorIndex.search(emb.embedding, {
        limit: PROMPT_CONTEXT_MAX_SPORES,
        type: 'spore',
        relativeThreshold: PROMPT_CONTEXT_MIN_SIMILARITY,
      });

      if (results.length === 0) return { body: { text: '' } };

      const noteMap = new Map(
        index.queryByIds(results.map((r) => r.id)).map((n) => [n.id, n]),
      );

      const lines: string[] = [];
      for (const r of results) {
        const note = noteMap.get(r.id);
        if (!note) continue;
        const fm = note.frontmatter as Record<string, unknown>;
        if (fm.status === 'superseded' || fm.status === 'archived') continue;
        const obsType = fm.observation_type as string ?? 'note';
        lines.push(`- [${obsType}] ${note.title}: ${note.content.slice(0, CONTENT_SNIPPET_CHARS)} \`[${note.id}]\``);
      }

      if (lines.length === 0) return { body: { text: '' } };

      const injected = `**Relevant spores for this task:**\n${lines.join('\n')}`;
      logger.debug('context', 'Prompt context injected', {
        session_id,
        spores: lines.length,
        prompt_preview: prompt.slice(0, 50),
      });

      return { body: { text: injected } };
    } catch (err) {
      logger.debug('context', 'Prompt context failed', { error: (err as Error).message });
      return { body: { text: '' } };
    }
  });

  const resolvedPort = await resolvePort(config.daemon.port, vaultDir);
  if (resolvedPort === 0) {
    logger.warn('daemon', 'All preferred ports occupied, using ephemeral port');
  }
  await server.start(resolvedPort);
  logger.info('daemon', 'Daemon ready', { vault: vaultDir, port: server.port });

  // Persist the resolved port to config if it was auto-derived
  if (config.daemon.port === null && resolvedPort !== 0) {
    config.daemon.port = resolvedPort;
    saveConfig(vaultDir, config);
    logger.info('daemon', 'Persisted auto-derived port to myco.yaml', { port: resolvedPort });
  }

  // Background reindex after migration — runs after server is healthy
  if (needsMigrationReindex) {
    setImmediate(() => {
      logger.info('daemon', 'Rebuilding index after memories→spores migration (background)');
      initFts(index);
      rebuildIndex(index, vaultDir);
      logger.info('daemon', 'Migration reindex complete');
    });
  }

  const shutdown = async (signal: string) => {
    logger.info('daemon', `${signal} received`);
    // Wait for any active stop processing to finish before shutting down
    if (activeStopProcessing) {
      logger.info('daemon', 'Waiting for active stop processing to complete...');
      await activeStopProcessing;
    }
    metabolism?.stop();
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

