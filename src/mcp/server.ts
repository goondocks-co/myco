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
import path from 'node:path';

interface ServerConfig {
  vaultDir: string;
  teamUser?: string;
}

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
        type: { type: 'string', enum: ['decision', 'gotcha', 'discovery', 'cross-cutting'] },
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
        status: { type: 'string', enum: ['active', 'completed', 'all'] },
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
    const { name, arguments: args } = request.params;
    const idx = getIndex();

    switch (name) {
      case 'myco_search':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoSearch(idx, args as any)) }] };
      case 'myco_recall':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoRecall(idx, args as any)) }] };
      case 'myco_remember':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoRemember(config.vaultDir, idx, args as any)) }] };
      case 'myco_plans':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoPlans(idx, args as any)) }] };
      case 'myco_sessions':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoSessions(idx, args as any)) }] };
      case 'myco_team':
        return { content: [{ type: 'text', text: JSON.stringify(await handleMycoTeam(idx, args as any, config.teamUser)) }] };
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
