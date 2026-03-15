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
import { resolveVaultDir } from '../vault/resolve.js';
import { loadConfig } from '../config/loader.js';
import { MemoryFrontmatterSchema, PlanFrontmatterSchema } from '../vault/types.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

interface ServerConfig {
  vaultDir: string;
  teamUser?: string;
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
    description: 'View daemon logs with filtering — useful for debugging capture, lifecycle, and embedding issues',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max entries to return (default 50)' },
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], description: 'Minimum log level' },
        component: { type: 'string', description: 'Filter by component (daemon, processor, hooks, lifecycle, embeddings)' },
        since: { type: 'string', description: 'ISO timestamp — entries after this time' },
        until: { type: 'string', description: 'ISO timestamp — entries before this time' },
      },
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const idx = getIndex();
    const input = args as Record<string, unknown>;

    switch (name) {
      case 'myco_search':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoSearch(idx, input as any)) }] };
      case 'myco_recall':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoRecall(idx, input as any)) }] };
      case 'myco_remember':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoRemember(config.vaultDir, idx, input as any)) }] };
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

  const server = createMycoServer({
    vaultDir,
    teamUser: config?.team?.user,
  });
  await server.start();
}
