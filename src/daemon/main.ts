import { DaemonServer } from './server.js';
import { SessionRegistry } from './lifecycle.js';
import { DaemonLogger } from './logger.js';
import { loadConfig } from '../config/loader.js';
import { BatchManager, type BatchEvent } from './batch.js';
import { BufferProcessor, type Observation } from './processor.js';
import { VaultWriter } from '../vault/writer.js';
import { MycoIndex } from '../index/sqlite.js';
import { indexNote } from '../index/rebuild.js';
import { createLlmBackend } from '../intelligence/llm.js';
import type { LlmBackend } from '../intelligence/llm.js';
import { VectorIndex } from '../index/vectors.js';
import { generateEmbedding } from '../intelligence/embeddings.js';
import { PlanWatcher } from './watcher.js';
import { buildInjectedContext } from '../context/injector.js';
import { TranscriptMiner } from '../capture/transcript-miner.js';
import { EventBuffer } from '../capture/buffer.js';
import { formatMemoryBody, formatSessionBody } from '../obsidian/formatter.js';
import { collectArtifactCandidates } from '../artifacts/candidates.js';
import { slugifyPath } from '../artifacts/slugify.js';
import fs from 'node:fs';
import path from 'node:path';

function writeObservations(
  observations: Observation[],
  sessionId: string,
  deps: {
    vault: VaultWriter;
    index: MycoIndex;
    vaultDir: string;
    vectorIndex: VectorIndex | null;
    llmBackend: LlmBackend;
    logger: DaemonLogger;
  },
): void {
  for (const obs of observations) {
    const obsId = `${obs.type}-${sessionId.slice(-6)}-${Date.now()}`;
    const body = formatMemoryBody({
      title: obs.title,
      observationType: obs.type,
      content: obs.content,
      sessionId,
      root_cause: obs.root_cause,
      fix: obs.fix,
      rationale: obs.rationale,
      alternatives_rejected: obs.alternatives_rejected,
      gained: obs.gained,
      sacrificed: obs.sacrificed,
      tags: obs.tags,
    });
    const relativePath = deps.vault.writeMemory({
      id: obsId,
      observation_type: obs.type,
      session: `session-${sessionId}`,
      tags: obs.tags,
      content: body,
    });
    indexNote(deps.index, deps.vaultDir, relativePath);
    deps.logger.info('processor', 'Observation written', { type: obs.type, title: obs.title, session_id: sessionId });

    if (deps.vectorIndex) {
      generateEmbedding(deps.llmBackend, `${obs.title}\n${obs.content}`)
        .then((emb) => deps.vectorIndex!.upsert(obsId, emb.embedding,
          { type: 'memory', importance: 'high', session_id: sessionId }))
        .catch((err) => deps.logger.debug('embeddings', 'Observation embedding failed',
          { obs_id: obsId, error: (err as Error).message }));
    }
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
  const llmBackend = await createLlmBackend(config.intelligence);

  let vectorIndex: VectorIndex | null = null;
  try {
    const testEmbed = await llmBackend.embed('test');
    vectorIndex = new VectorIndex(path.join(vaultDir, 'vectors.db'), testEmbed.dimensions);
    logger.info('embeddings', 'Vector index initialized', { dimensions: testEmbed.dimensions });
  } catch (error) {
    logger.warn('embeddings', 'Vector index unavailable', { error: (error as Error).message });
  }

  const processor = new BufferProcessor(llmBackend);
  const vault = new VaultWriter(vaultDir);
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));
  const transcriptMiner = new TranscriptMiner({
    additionalPaths: config.capture.transcript_paths,
  });

  const bufferDir = path.join(vaultDir, 'buffer');
  const sessionBuffers = new Map<string, EventBuffer>();

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

  const planWatcher = new PlanWatcher({
    projectRoot: process.cwd(),
    watchPaths: config.capture.artifact_watch,
    onPlan: (event) => {
      logger.info('watcher', 'Plan detected', { source: event.source, file: event.filePath });

      // Index and embed plan files
      if (event.filePath && fs.existsSync(event.filePath)) {
        try {
          const relativePath = path.relative(vaultDir, event.filePath);
          indexNote(index, vaultDir, relativePath);
          logger.info('watcher', 'Plan indexed', { path: relativePath });

          if (vectorIndex) {
            const content = fs.readFileSync(event.filePath, 'utf-8');
            const title = content.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(event.filePath);
            const planId = `plan-${path.basename(event.filePath, '.md')}`;
            generateEmbedding(llmBackend, `${title}\n${content}`.slice(0, 8000))
              .then((emb) => vectorIndex!.upsert(planId, emb.embedding, { type: 'plan' }))
              .catch((err) => logger.debug('embeddings', 'Plan embedding failed', { error: (err as Error).message }));
          }
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
      writeObservations(result.observations, sessionId, { vault, index, vaultDir, vectorIndex, llmBackend, logger });
    }

    logger.debug('processor', 'Batch processed', {
      session_id: sessionId,
      events: closedBatch.length,
      observations: result.observations.length,
      degraded: result.degraded,
    });
  });

  // Session routes
  server.registerRoute('POST', '/sessions/register', async (body: any) => {
    registry.register(body.session_id);
    server.updateDaemonJsonSessions(registry.sessions);
    logger.info('lifecycle', 'Session registered', { session_id: body.session_id });
    return { ok: true, sessions: registry.sessions };
  });

  server.registerRoute('POST', '/sessions/unregister', async (body: any) => {
    registry.unregister(body.session_id);
    // Note: we do NOT delete the buffer here. Session reload (SessionEnd → SessionStart)
    // reuses the same session_id, and deleting would wipe all prior events.
    // Buffers are cleaned up by age during rebuild or daemon startup.
    server.updateDaemonJsonSessions(registry.sessions);
    logger.info('lifecycle', 'Session unregistered', { session_id: body.session_id });
    return { ok: true, sessions: registry.sessions };
  });

  // Event routes
  server.registerRoute('POST', '/events', async (body: any) => {
    const event = { ...body, timestamp: body.timestamp ?? new Date().toISOString() } as BatchEvent;
    logger.debug('hooks', 'Event received', { type: event.type, session_id: event.session_id });

    // Persist to disk so events survive daemon restarts
    if (!sessionBuffers.has(event.session_id)) {
      sessionBuffers.set(event.session_id, new EventBuffer(bufferDir, event.session_id));
    }
    sessionBuffers.get(event.session_id)!.append(event as Record<string, unknown>);

    batchManager.addEvent(event);
    if (body.type === 'tool_use') {
      planWatcher.checkToolEvent({ tool_name: body.tool_name, tool_input: body.tool_input, session_id: body.session_id });
    }
    return { ok: true };
  });

  server.registerRoute('POST', '/events/stop', async (body: any) => {
    const { session_id: sessionId, user } = body as { session_id: string; user?: string };
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
        writeObservations(result.observations, sessionId, { vault, index, vaultDir, vectorIndex, llmBackend, logger });
      }
    }

    // --- Artifact capture ---
    try {
      const allEvents = sessionBuffers.get(sessionId)?.readAll() ?? [];
      const artifactCandidates = collectArtifactCandidates(
        allEvents,
        { artifact_extensions: config.capture.artifact_extensions },
        process.cwd(),
      );

      if (artifactCandidates.length > 0) {
        const classified = await processor.classifyArtifacts(artifactCandidates, sessionId);

        for (const artifact of classified) {
          const candidate = artifactCandidates.find((c) => c.path === artifact.source_path);
          if (!candidate) continue;

          const validTypes = new Set(['spec', 'plan', 'rfc', 'doc', 'other']);
          if (!validTypes.has(artifact.artifact_type)) {
            logger.warn('processor', 'Skipping artifact with invalid type', {
              source_path: artifact.source_path,
              artifact_type: artifact.artifact_type,
            });
            continue;
          }

          const artifactId = slugifyPath(artifact.source_path);
          const artifactPath = vault.writeArtifact({
            id: artifactId,
            artifact_type: artifact.artifact_type,
            source_path: artifact.source_path,
            title: artifact.title,
            session: sessionId,
            tags: artifact.tags,
            content: candidate.content,
          });

          indexNote(index, vaultDir, artifactPath);

          if (vectorIndex) {
            generateEmbedding(llmBackend, `${artifact.title}\n${candidate.content}`.slice(0, 8000))
              .then((emb) =>
                vectorIndex!.upsert(artifactId, emb.embedding, {
                  type: 'artifact',
                  artifact_type: artifact.artifact_type,
                  session_id: sessionId,
                }),
              )
              .catch((err) =>
                logger.debug('embeddings', 'Artifact embedding failed', {
                  id: artifactId,
                  error: (err as Error).message,
                }),
              );
          }

          logger.info('processor', 'Artifact captured', {
            id: artifactId,
            type: artifact.artifact_type,
            source: artifact.source_path,
          });
        }
      }
    } catch (err) {
      logger.warn('processor', 'Artifact capture failed', {
        session_id: sessionId,
        error: (err as Error).message,
      });
    }

    // Build the new turn from this batch
    const batchTurns = extractTurns(lastBatch);
    const ended = new Date().toISOString();

    // Read existing session file to preserve prior turns
    const date = new Date().toISOString().slice(0, 10);
    const relativePath = `sessions/${date}/session-${sessionId}.md`;
    const fullPath = path.join(vaultDir, relativePath);

    let existingContent = '';
    let existingTurnCount = 0;
    let started = ended;
    if (fs.existsSync(fullPath)) {
      existingContent = fs.readFileSync(fullPath, 'utf-8');
      // Count existing turns
      const turnMatches = existingContent.match(/^### Turn \d+/gm);
      existingTurnCount = turnMatches?.length ?? 0;
      // Extract started from frontmatter
      const startedMatch = existingContent.match(/^started:\s*"?(.+?)"?\s*$/m);
      if (startedMatch) started = startedMatch[1];
    } else {
      started = lastBatch.length > 0 ? String(lastBatch[0].timestamp) : ended;
    }

    // Build new turn lines
    const newTurnLines: string[] = [];
    for (let i = 0; i < batchTurns.length; i++) {
      const turn = batchTurns[i];
      const turnNum = existingTurnCount + i + 1;
      newTurnLines.push(`\n\n### Turn ${turnNum}\n`);
      if (turn.prompt) newTurnLines.push(`**Prompt**: ${turn.prompt}\n`);
      if (turn.toolCount > 0) newTurnLines.push(`**Tools**: ${turn.toolCount} calls\n`);
      if (turn.aiResponse) newTurnLines.push(`**Response**: ${turn.aiResponse}`);
    }

    // Build the conversation section: preserve existing turns + append new
    let conversationSection: string;
    if (existingTurnCount > 0 && existingContent) {
      // Extract existing conversation (everything from ## Conversation onward, without frontmatter)
      const bodyStart = existingContent.indexOf('---', 3);
      const body = bodyStart >= 0 ? existingContent.slice(bodyStart + 3).replace(/^\n+/, '') : existingContent;
      // Find the conversation section
      const convIdx = body.indexOf('## Conversation');
      if (convIdx >= 0) {
        conversationSection = body.slice(convIdx).replace(/\n+$/, '') + newTurnLines.join('\n');
      } else {
        conversationSection = '## Conversation\n' + newTurnLines.join('\n');
      }
    } else {
      conversationSection = '## Conversation\n' + newTurnLines.join('\n');
    }

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
        return fm.session === `session-${sessionId}` || fm.session === sessionId;
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
      existingTurnCount: existingTurnCount,
    });

    vault.writeSession({
      id: sessionId,
      user,
      started,
      ended,
      tools_used: existingTurnCount + batchTurns.length,
      summary,
    });
    indexNote(index, vaultDir, relativePath);

    if (vectorIndex && narrative) {
      try {
        const emb = await generateEmbedding(llmBackend, narrative);
        vectorIndex.upsert(`session-${sessionId}`, emb.embedding, { type: 'session', session_id: sessionId });
      } catch (err) {
        logger.debug('embeddings', 'Session embedding failed', { session_id: sessionId, error: (err as Error).message });
      }
    }

    logger.info('processor', 'Session note written', { session_id: sessionId, path: relativePath });
    return { ok: true, path: relativePath };
  });

  server.registerRoute('POST', '/context', async (body: any) => {
    logger.debug('hooks', 'Context query', { session_id: body.session_id });
    try {
      if (vectorIndex && body.branch) {
        const queryText = `branch: ${body.branch} files: ${(body.files ?? []).join(' ')}`;
        const emb = await generateEmbedding(llmBackend, queryText);
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
      const injected = buildInjectedContext(index, config, { branch: body.branch, files: body.files });
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

main().catch((err) => {
  process.stderr.write(`[mycod] Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
