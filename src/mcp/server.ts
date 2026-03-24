import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { getPluginVersion } from '../version.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { handleMycoSearch } from './tools/search.js';
import { handleMycoRecall } from './tools/recall.js';
import { handleMycoRemember } from './tools/remember.js';
import { handleMycoPlans } from './tools/plans.js';
import { handleMycoSessions } from './tools/sessions.js';
import { handleMycoTeam } from './tools/team.js';
import { handleMycoGraph } from './tools/graph.js';
import { handleMycoSupersede } from './tools/supersede.js';
import { handleMycoConsolidate } from './tools/consolidate.js';
import { handleMycoContext } from './tools/context.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { DaemonClient } from '../hooks/client.js';
import { DAEMON_CLIENT_TIMEOUT_MS } from '../constants.js';

import {
  TOOL_DEFINITIONS,
  TOOL_SEARCH, TOOL_RECALL, TOOL_REMEMBER, TOOL_PLANS, TOOL_SESSIONS,
  TOOL_TEAM, TOOL_GRAPH, TOOL_SUPERSEDE, TOOL_CONSOLIDATE,
  TOOL_CONTEXT,
} from './tool-definitions.js';

export interface MycoServer {
  name: string;
  getRegisteredTools(): string[];
  start(): Promise<void>;
}

export function createMycoServer(vaultDir: string, client: DaemonClient): MycoServer {
  const server = new Server(
    { name: 'myco', version: getPluginVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  /** Log MCP tool activity to vault logs for auditability. */
  function logActivity(tool: string, detail: Record<string, unknown>): void {
    const logDir = path.join(vaultDir, 'logs');
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
        const daemonJsonPath = path.join(vaultDir, 'daemon.json');
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
    const input = args as Record<string, unknown>;
    const start = Date.now();

    switch (name) {
      case TOOL_SEARCH: {
        const searchInput = input as { query: string; type?: string; limit?: number };
        const result = await handleMycoSearch(searchInput, client);
        logActivity(TOOL_SEARCH, { query: searchInput.query, matches: result.length, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_RECALL: {
        const recallInput = input as { note_id: string };
        const result = await handleMycoRecall(recallInput, client);
        logActivity(TOOL_RECALL, { note_id: recallInput.note_id, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_REMEMBER: {
        const rememberInput = input as { content: string; type?: string; tags?: string[] };
        const result = await handleMycoRemember(rememberInput, client);
        logActivity(TOOL_REMEMBER, { id: result.id, observation_type: result.observation_type, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_PLANS: {
        const plansInput = input as { status?: string; limit?: number };
        const result = await handleMycoPlans(plansInput, client);
        logActivity(TOOL_PLANS, { count: result.length, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_SESSIONS: {
        const sessionsInput = input as { limit?: number; status?: string };
        const result = await handleMycoSessions(sessionsInput, client);
        logActivity(TOOL_SESSIONS, { count: result.length, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_TEAM: {
        const teamInput = input as Record<string, unknown>;
        const result = await handleMycoTeam(teamInput, client);
        logActivity(TOOL_TEAM, { count: result.length, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_GRAPH: {
        const graphInput = input as { note_id: string; direction?: 'incoming' | 'outgoing' | 'both'; depth?: number };
        const result = await handleMycoGraph(graphInput, client);
        logActivity(TOOL_GRAPH, { note_id: graphInput.note_id, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_SUPERSEDE: {
        const supersedeInput = input as { old_spore_id: string; new_spore_id: string; reason?: string };
        const result = await handleMycoSupersede(supersedeInput, client);
        logActivity(TOOL_SUPERSEDE, { old: result.old_spore, new: result.new_spore, status: result.status, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_CONSOLIDATE: {
        const consolidateInput = input as { source_spore_ids: string[] };
        const result = await handleMycoConsolidate(consolidateInput);
        logActivity(TOOL_CONSOLIDATE, { status: result.status, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_CONTEXT: {
        const contextInput = input as { tier?: number };
        const result = await handleMycoContext(contextInput, client);
        logActivity(TOOL_CONTEXT, { tier: contextInput.tier, duration_ms: Date.now() - start });
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
  const client = new DaemonClient(vaultDir);
  const server = createMycoServer(vaultDir, client);
  await server.start();
}
