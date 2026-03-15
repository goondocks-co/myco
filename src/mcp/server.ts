import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
import { resolveVaultDir } from '../vault/resolve.js';
import { loadConfig } from '../config/loader.js';
import { createEmbeddingProvider } from '../intelligence/llm.js';
import type { EmbeddingProvider } from '../intelligence/llm.js';
import { VectorIndex } from '../index/vectors.js';
import { generateEmbedding } from '../intelligence/embeddings.js';
import { PlanFrontmatterSchema } from '../vault/types.js';
import { EMBEDDING_INPUT_LIMIT } from '../constants.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

interface ServerConfig {
  vaultDir: string;
  teamUser?: string;
  embeddingProvider?: EmbeddingProvider;
  vectorIndex?: VectorIndex;
}

// Common observation types shown as hints in the tool schema; the vault accepts any string
const OBSERVATION_TYPES = ['gotcha', 'bug_fix', 'decision', 'discovery', 'trade_off', 'cross-cutting'];
const PLAN_STATUSES = [...PlanFrontmatterSchema.shape.status._def.innerType.options, 'all'];

const TOOL_DEFINITIONS = [
  {
    name: 'myco_search',
    description: 'Combined semantic + full-text search across the vault',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        type: { type: 'string', enum: ['session', 'plan', 'memory', 'all'] },
        limit: { type: 'number', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'myco_recall',
    description: 'Automatic context retrieval based on current work',
    inputSchema: {
      type: 'object' as const,
      properties: {
        branch: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'myco_remember',
    description: 'Store an observation as a memory note',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string' },
        type: { type: 'string', enum: OBSERVATION_TYPES },
        tags: { type: 'array', items: { type: 'string' } },
        related_plan: { type: 'string' },
      },
      required: ['content', 'type'],
    },
  },
  {
    name: 'myco_plans',
    description: 'List active plans with progress',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: PLAN_STATUSES },
        id: { type: 'string' },
      },
    },
  },
  {
    name: 'myco_sessions',
    description: 'Query session history with filters',
    inputSchema: {
      type: 'object' as const,
      properties: {
        plan: { type: 'string' },
        branch: { type: 'string' },
        user: { type: 'string' },
        since: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'myco_team',
    description: 'Teammate activity on same files or plan',
    inputSchema: {
      type: 'object' as const,
      properties: {
        files: { type: 'array', items: { type: 'string' } },
        plan: { type: 'string' },
        since: { type: 'string' },
      },
    },
  },
  {
    name: 'myco_graph',
    description: 'Traverse vault connections via wikilinks — find related notes by following links',
    inputSchema: {
      type: 'object' as const,
      properties: {
        note_id: { type: 'string', description: 'Note ID to start from (e.g. "session-abc123")' },
        direction: { type: 'string', enum: ['incoming', 'outgoing', 'both'], description: 'Link direction (default: both)' },
        depth: { type: 'number', description: 'Traversal depth 1-3 (default: 1)' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'myco_orphans',
    description: 'Find vault notes with no incoming or outgoing wikilinks',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'myco_logs',
    description: 'View daemon and MCP activity logs with filtering — useful for debugging and auditing',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max entries to return (default 50)' },
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], description: 'Minimum log level' },
        component: { type: 'string', description: 'Filter by component (daemon, processor, hooks, lifecycle, embeddings, mcp, lineage, watcher)' },
        since: { type: 'string', description: 'ISO timestamp — entries after this time' },
        until: { type: 'string', description: 'ISO timestamp — entries before this time' },
      },
    },
  },
  {
    name: 'myco_supersede',
    description: 'Mark a memory as superseded by a newer one — use when an older observation is outdated, incorrect, or replaced by better understanding',
    inputSchema: {
      type: 'object' as const,
      properties: {
        old_memory_id: { type: 'string', description: 'ID of the memory to supersede' },
        new_memory_id: { type: 'string', description: 'ID of the memory that replaces it' },
        reason: { type: 'string', description: 'Why this memory is being superseded' },
      },
      required: ['old_memory_id', 'new_memory_id'],
    },
  },
  {
    name: 'myco_consolidate',
    description: 'Merge multiple related memories into a single wisdom note — use when several observations describe aspects of the same insight or pattern',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_memory_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of memories to consolidate' },
        consolidated_content: { type: 'string', description: 'The merged, comprehensive content for the wisdom note' },
        observation_type: { type: 'string', enum: OBSERVATION_TYPES, description: 'Type for the consolidated note' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the wisdom note' },
      },
      required: ['source_memory_ids', 'consolidated_content', 'observation_type'],
    },
  },
];

export interface MycoServer {
  name: string;
  getRegisteredTools(): string[];
  start(): Promise<void>;
}

export function createMycoServer(config: ServerConfig): MycoServer {
  const server = new Server(
    { name: 'myco', version: '0.1.0' },
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
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const entry = JSON.stringify({ timestamp: new Date().toISOString(), component: 'mcp', level: 'info', tool, ...detail }) + '\n';
      fs.appendFileSync(path.join(logDir, 'mcp.jsonl'), entry);
    } catch { /* logging failure is non-fatal */ }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const idx = getIndex();
    const input = args as Record<string, unknown>;

    switch (name) {
      case 'myco_search':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoSearch(idx, input as any, config.vectorIndex, config.embeddingProvider)) }] };
      case 'myco_recall':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoRecall(idx, input as any)) }] };
      case 'myco_remember': {
        const result = await handleMycoRemember(config.vaultDir, idx, input as any);
        embedNote(result.id, String(input.content), { type: 'memory', observation_type: String(input.type ?? ''), importance: 'high' });
        logActivity('myco_remember', { id: result.id, observation_type: input.type, path: result.note_path });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'myco_plans':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoPlans(idx, input as any)) }] };
      case 'myco_sessions':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoSessions(idx, input as any)) }] };
      case 'myco_team':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoTeam(idx, input as any, config.teamUser)) }] };
      case 'myco_graph':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoGraph(idx, input as any)) }] };
      case 'myco_orphans':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoOrphans(idx)) }] };
      case 'myco_logs':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoLogs(config.vaultDir, input as any)) }] };
      case 'myco_supersede': {
        const result = await handleMycoSupersede(config.vaultDir, idx, input as any);
        if (result.status === 'superseded' && config.vectorIndex) {
          config.vectorIndex.delete(result.old_memory);
        }
        logActivity('myco_supersede', { old: result.old_memory, new: result.new_memory, status: result.status });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'myco_consolidate': {
        const result = await handleMycoConsolidate(config.vaultDir, idx, input as any);
        embedNote(result.wisdom_id, String(input.consolidated_content), { type: 'memory', observation_type: String(input.observation_type ?? ''), importance: 'high' });
        if (config.vectorIndex && Array.isArray(input.source_memory_ids)) {
          for (const id of input.source_memory_ids as string[]) {
            config.vectorIndex.delete(id);
          }
        }
        logActivity('myco_consolidate', { wisdom_id: result.wisdom_id, sources: input.source_memory_ids, archived: result.sources_archived });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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

// Entry point — invoked by .mcp.json: node dist/src/mcp/server.js
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch((err) => {
    process.stderr.write(`[myco-mcp] Fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const vaultDir = resolveVaultDir();

  const config = fs.existsSync(path.join(vaultDir, 'myco.yaml'))
    ? loadConfig(vaultDir)
    : undefined;

  // Initialize embedding provider + vector index (same as daemon does)
  let embeddingProvider: EmbeddingProvider | undefined;
  let vectorIndex: VectorIndex | undefined;

  if (config) {
    try {
      embeddingProvider = createEmbeddingProvider(config.intelligence.embedding);
      const testEmbed = await embeddingProvider.embed('test');
      vectorIndex = new VectorIndex(path.join(vaultDir, 'vectors.db'), testEmbed.dimensions);
    } catch {
      // Embedding unavailable — MCP tools fall back to FTS only
    }
  }

  const server = createMycoServer({
    vaultDir,
    teamUser: config?.team?.user,
    embeddingProvider,
    vectorIndex,
  });
  await server.start();
}
