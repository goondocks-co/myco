import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { getPluginVersion } from '../version.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MycoIndex } from '../index/sqlite.js';
import { initFts } from '../index/fts.js';
import { handleMycoSearch } from './tools/search.js';
import { handleMycoRecall } from './tools/recall.js';
import { handleMycoRemember } from './tools/remember.js';
import { handleMycoPlans } from './tools/plans.js';
import { handleMycoSessions } from './tools/sessions.js';
import { handleMycoTeam } from './tools/team.js';
import { handleMycoGraph, handleMycoOrphans } from './tools/graph.js';
import { handleMycoLogs } from './tools/logs.js';
import { handleMycoSupersede } from './tools/supersede.js';
import { handleMycoConsolidate } from './tools/consolidate.js';
import { handleMycoContext } from './tools/context.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { loadConfig } from '../config/loader.js';
import { createEmbeddingProvider, createLlmProvider } from '../intelligence/llm.js';
import type { EmbeddingProvider, LlmProvider } from '../intelligence/llm.js';
import { VectorIndex } from '../index/vectors.js';
import { generateEmbedding } from '../intelligence/embeddings.js';
import { EMBEDDING_INPUT_LIMIT, DAEMON_CLIENT_TIMEOUT_MS } from '../constants.js';
import { checkSupersession } from '../vault/curation.js';

interface ServerConfig {
  vaultDir: string;
  teamUser?: string;
  embeddingProvider?: EmbeddingProvider;
  vectorIndex?: VectorIndex;
  llmProvider?: LlmProvider;
}

// Common observation types shown as hints in the tool schema; the vault accepts any string

import {
  TOOL_DEFINITIONS,
  TOOL_SEARCH, TOOL_RECALL, TOOL_REMEMBER, TOOL_PLANS, TOOL_SESSIONS,
  TOOL_TEAM, TOOL_GRAPH, TOOL_ORPHANS, TOOL_LOGS, TOOL_SUPERSEDE, TOOL_CONSOLIDATE,
  TOOL_CONTEXT,
} from './tool-definitions.js';

export interface MycoServer {
  name: string;
  getRegisteredTools(): string[];
  start(): Promise<void>;
}

export function createMycoServer(config: ServerConfig): MycoServer {
  const server = new Server(
    { name: 'myco', version: getPluginVersion() },
    { capabilities: { tools: {} } },
  );

  const dbPath = path.join(config.vaultDir, 'index.db');
  let index: MycoIndex | null = null;

  function getIndex(): MycoIndex {
    if (!index) {
      index = new MycoIndex(dbPath);
      initFts(index);
    }
    return index;
  }

  /** Embed a note and upsert into vector index (fire-and-forget). */
  function embedNote(noteId: string, text: string, metadata: Record<string, string>): void {
    if (!config.embeddingProvider || !config.vectorIndex || !text) return;
    generateEmbedding(config.embeddingProvider, text.slice(0, EMBEDDING_INPUT_LIMIT))
      .then((emb) => config.vectorIndex!.upsert(noteId, emb.embedding, metadata))
      .catch(() => { /* embedding failure is non-fatal */ });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  /** Log MCP tool activity to vault logs for auditability. */
  function logActivity(tool: string, detail: Record<string, unknown>): void {
    const logDir = path.join(config.vaultDir, 'logs');
    // Primary: write to mcp.jsonl (always works, no daemon dependency)
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const entry = JSON.stringify({ timestamp: new Date().toISOString(), component: 'mcp', level: 'info', tool, ...detail }) + '\n';
      fs.appendFileSync(path.join(logDir, 'mcp.jsonl'), entry);
    } catch { /* logging failure is non-fatal */ }

    // Secondary: fire-and-forget POST to daemon for ring buffer visibility
    postToDaemon('info', 'mcp', `Tool call: ${tool}`, { tool, ...detail });
  }

  /** Fire-and-forget log POST to daemon. Port cached after first read. */
  let cachedDaemonPort: number | null = null;
  function postToDaemon(level: string, component: string, message: string, data?: Record<string, unknown>): void {
    try {
      if (cachedDaemonPort === null) {
        const daemonJsonPath = path.join(config.vaultDir, 'daemon.json');
        const raw = fs.readFileSync(daemonJsonPath, 'utf-8');
        cachedDaemonPort = (JSON.parse(raw) as { port: number }).port;
      }
      fetch(`http://127.0.0.1:${cachedDaemonPort}/api/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, component, message, data }),
        signal: AbortSignal.timeout(DAEMON_CLIENT_TIMEOUT_MS),
      }).catch(() => { cachedDaemonPort = null; });
    } catch { cachedDaemonPort = null; }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const idx = getIndex();
    const input = args as Record<string, unknown>;
    const start = Date.now();

    switch (name) {
      case TOOL_SEARCH: {
        const result = await handleMycoSearch(idx, input as any, config.vectorIndex, config.embeddingProvider);
        logActivity(TOOL_SEARCH, { query: input.query, matches: result.length, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_RECALL: {
        const result = await handleMycoRecall(idx, input as any);
        logActivity(TOOL_RECALL, { id: input.id, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_REMEMBER: {
        const result = await handleMycoRemember(config.vaultDir, idx, input as any);
        embedNote(result.id, String(input.content), { type: 'spore', observation_type: String(input.type ?? ''), importance: 'high' });
        // Fire-and-forget supersession check
        if (config.vectorIndex && config.embeddingProvider && config.llmProvider) {
          checkSupersession(result.id, {
            index: idx,
            vectorIndex: config.vectorIndex,
            embeddingProvider: config.embeddingProvider,
            llmProvider: config.llmProvider,
            vaultDir: config.vaultDir,
          }).catch(() => { /* non-fatal */ });
        }
        logActivity(TOOL_REMEMBER, { id: result.id, observation_type: input.type, path: result.note_path, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_PLANS: {
        const result = await handleMycoPlans(idx, input as any);
        logActivity(TOOL_PLANS, { count: Array.isArray(result) ? result.length : 1, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_SESSIONS: {
        const result = await handleMycoSessions(idx, input as any);
        logActivity(TOOL_SESSIONS, { count: result.length, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_TEAM: {
        const result = await handleMycoTeam(idx, input as any, config.teamUser);
        logActivity(TOOL_TEAM, { count: result.length, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_GRAPH: {
        const result = await handleMycoGraph(idx, input as any);
        logActivity(TOOL_GRAPH, { duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_ORPHANS: {
        const result = await handleMycoOrphans(idx);
        logActivity(TOOL_ORPHANS, { count: result.orphans?.length ?? 0, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_LOGS: {
        const result = await handleMycoLogs(config.vaultDir, input as any);
        logActivity(TOOL_LOGS, { query_level: input.level, query_component: input.component, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_SUPERSEDE: {
        const result = await handleMycoSupersede(config.vaultDir, idx, input as any);
        if (result.status === 'superseded' && config.vectorIndex) {
          config.vectorIndex.delete(result.old_spore);
        }
        logActivity(TOOL_SUPERSEDE, { old: result.old_spore, new: result.new_spore, status: result.status, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_CONSOLIDATE: {
        const result = await handleMycoConsolidate(config.vaultDir, idx, input as any, config.vectorIndex ?? null, config.embeddingProvider ?? null);
        logActivity(TOOL_CONSOLIDATE, { wisdom_id: result.wisdom_id, sources: input.source_spore_ids, archived: result.sources_archived, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_CONTEXT: {
        const result = handleMycoContext(config.vaultDir, args as { tier?: number });
        logActivity(TOOL_CONTEXT, { tier: (args as { tier?: number }).tier, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: result.content }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return {
    name: 'myco',
    getRegisteredTools() {
      return TOOL_DEFINITIONS.map((t) => t.name);
    },
    async start() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
  };
}

export async function main(): Promise<void> {
  const vaultDir = resolveVaultDir();

  const config = fs.existsSync(path.join(vaultDir, 'myco.yaml'))
    ? loadConfig(vaultDir)
    : undefined;

  // Initialize embedding provider + vector index (same as daemon does)
  let embeddingProvider: EmbeddingProvider | undefined;
  let vectorIndex: VectorIndex | undefined;
  let llmProvider: LlmProvider | undefined;

  if (config) {
    try {
      embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);
      const testEmbed = await embeddingProvider.embed('test');
      vectorIndex = new VectorIndex(path.join(vaultDir, 'vectors.db'), testEmbed.dimensions);
    } catch {
      // Embedding unavailable — MCP tools fall back to FTS only
    }
    try {
      llmProvider = createLlmProvider(config.intelligence.llm);
    } catch {
      // LLM unavailable — supersession checks will be skipped
    }
  }

  const server = createMycoServer({
    vaultDir,
    teamUser: config?.team?.user,
    embeddingProvider,
    vectorIndex,
    llmProvider,
  });
  await server.start();
}
