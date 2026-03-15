import { DaemonServer } from './server.js';
import { SessionRegistry } from './lifecycle.js';
import { DaemonLogger } from './logger.js';
import { loadConfig } from '../config/loader.js';
import { BatchManager, type BatchEvent } from './batch.js';
import { BufferProcessor } from './processor.js';
import { VaultWriter } from '../vault/writer.js';
import { MycoIndex } from '../index/sqlite.js';
import { indexNote } from '../index/rebuild.js';
import { createLlmBackend } from '../intelligence/llm.js';
import { VectorIndex } from '../index/vectors.js';
import { generateEmbedding } from '../intelligence/embeddings.js';
import { PlanWatcher } from './watcher.js';
import { buildInjectedContext } from '../context/injector.js';
import path from 'node:path';

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

  // Accumulates all events per session for use by the stop handler
  const sessionEvents: Map<string, BatchEvent[]> = new Map();

  const planWatcher = new PlanWatcher({
    projectRoot: process.cwd(),
    watchPaths: config.capture.artifact_watch,
    onPlan: (event) => {
      logger.info('watcher', 'Plan detected', { source: event.source, file: event.filePath });
    },
  });
  planWatcher.startFileWatcher();

  const batchManager = new BatchManager(async (closedBatch: BatchEvent[]) => {
    if (closedBatch.length === 0) return;

    const sessionId = closedBatch[0].session_id;

    // Accumulate for later summary
    const existing = sessionEvents.get(sessionId) ?? [];
    sessionEvents.set(sessionId, [...existing, ...closedBatch]);

    // Extract observations from this batch
    const asRecords = closedBatch as Array<Record<string, unknown>>;
    const result = await processor.process(asRecords, sessionId);

    if (!result.degraded) {
      for (const obs of result.observations) {
        const obsId = `${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const relativePath = vault.writeMemory({
          id: obsId,
          observation_type: obs.type,
          session: sessionId,
          tags: obs.tags,
          content: `# ${obs.title}\n\n${obs.content}`,
        });
        indexNote(index, vaultDir, relativePath);
        logger.info('processor', 'Observation written', { type: obs.type, title: obs.title, session_id: sessionId });

        if (vectorIndex) {
          try {
            const emb = await generateEmbedding(llmBackend, `${obs.title}\n${obs.content}`);
            vectorIndex.upsert(obsId, emb.embedding,
              { type: 'memory', importance: 'high', session_id: sessionId });
          } catch (err) {
            logger.debug('embeddings', 'Observation embedding failed', { obs_id: obsId, error: (err as Error).message });
          }
        }
      }
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
    server.updateDaemonJsonSessions(registry.sessions);
    logger.info('lifecycle', 'Session unregistered', { session_id: body.session_id });
    return { ok: true, sessions: registry.sessions };
  });

  // Event routes
  server.registerRoute('POST', '/events', async (body: any) => {
    const event = { ...body, timestamp: body.timestamp ?? new Date().toISOString() } as BatchEvent;
    logger.debug('hooks', 'Event received', { type: event.type, session_id: event.session_id });
    batchManager.addEvent(event);
    if (body.type === 'tool_use') {
      planWatcher.checkToolEvent({ tool_name: body.tool_name, tool_input: body.tool_input, session_id: body.session_id });
    }
    return { ok: true };
  });

  server.registerRoute('POST', '/events/stop', async (body: any) => {
    const { session_id: sessionId, user } = body as { session_id: string; user?: string };
    logger.info('hooks', 'Stop received', { session_id: sessionId });

    // Finalize the last open batch and process it
    const lastBatch = batchManager.finalize(sessionId);
    const priorEvents = sessionEvents.get(sessionId) ?? [];

    if (lastBatch.length > 0) {
      const asRecords = lastBatch as Array<Record<string, unknown>>;
      const result = await processor.process(asRecords, sessionId);

      if (!result.degraded) {
        for (const obs of result.observations) {
          const obsId = `${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const relativePath = vault.writeMemory({
            id: obsId,
            observation_type: obs.type,
            session: sessionId,
            tags: obs.tags,
            content: `# ${obs.title}\n\n${obs.content}`,
          });
          indexNote(index, vaultDir, relativePath);
          logger.info('processor', 'Observation written', { type: obs.type, title: obs.title, session_id: sessionId });
        }
      }
    }

    // Generate session summary from ALL events
    const allEvents = [...priorEvents, ...lastBatch] as Array<Record<string, unknown>>;
    const started = allEvents.length > 0
      ? String((allEvents[0] as BatchEvent).timestamp ?? new Date().toISOString())
      : new Date().toISOString();
    const ended = new Date().toISOString();

    let summary = `Session ${sessionId} — ${allEvents.length} events.`;
    let title = `Session ${sessionId}`;

    if (allEvents.length > 0) {
      try {
        const result = await processor.summarize(allEvents, sessionId, user);
        summary = result.summary;
        title = result.title;
      } catch (err) {
        logger.warn('processor', 'Summarization failed', { session_id: sessionId, error: (err as Error).message });
      }
    }

    const relativePath = vault.writeSession({
      id: sessionId,
      user,
      started,
      ended,
      tools_used: allEvents.length,
      summary: `# ${title}\n\n${summary}`,
    });
    indexNote(index, vaultDir, relativePath);

    if (vectorIndex && summary) {
      try {
        const emb = await generateEmbedding(llmBackend, summary);
        vectorIndex.upsert(`session-${sessionId}`, emb.embedding, { type: 'session', session_id: sessionId });
      } catch (err) {
        logger.debug('embeddings', 'Session embedding failed', { session_id: sessionId, error: (err as Error).message });
      }
    }

    // Clean up accumulated events for this session
    sessionEvents.delete(sessionId);

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
          limit: 10, similarityFloor: config.intelligence.similarity_floor,
        });
        if (results.length > 0) {
          const parts: string[] = [];
          let budget = config.context.max_tokens;
          const sorted = results.sort((a, b) => {
            const imp = { high: 0, medium: 1, low: 2 } as Record<string, number>;
            return (imp[a.metadata.importance] ?? 1) - (imp[b.metadata.importance] ?? 1) || b.similarity - a.similarity;
          });
          for (const r of sorted) {
            const note = index.query({ id: r.id, limit: 1 })[0];
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
