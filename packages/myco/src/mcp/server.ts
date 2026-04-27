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
import { handleMycoSavePlan } from './tools/save-plan.js';
import { handleMycoSessions } from './tools/sessions.js';
import { handleMycoSupersede } from './tools/supersede.js';
import { handleMycoConsolidate } from './tools/consolidate.js';
import { handleMycoContext } from './tools/context.js';
import { handleMycoSkills } from './tools/skills.js';
import {
  handleCollectiveProject,
  handleCollectiveProjects,
  handleCollectiveSearch,
  handleCollectiveSettings,
} from './tools/collective.js';
import { handleMycoRuns } from './tools/runs.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { DaemonClient } from '../hooks/client.js';
import { DAEMON_CLIENT_TIMEOUT_MS } from '../constants.js';

import {
  TOOL_DEFINITIONS,
  TOOL_SEARCH, TOOL_RECALL, TOOL_REMEMBER, TOOL_PLANS, TOOL_SAVE_PLAN, TOOL_SESSIONS,
  TOOL_SUPERSEDE, TOOL_CONSOLIDATE,
  TOOL_CONTEXT, TOOL_SKILLS,
  TOOL_COLLECTIVE_SEARCH, TOOL_COLLECTIVE_PROJECTS, TOOL_COLLECTIVE_PROJECT, TOOL_COLLECTIVE_SETTINGS,
  TOOL_RUNS,
  COLLECTIVE_TOOL_DEFINITIONS,
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

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const teamStatus = await client.get('/api/team/status');
    const collectiveEnabled = Boolean(teamStatus.ok && teamStatus.data?.collective_connected);
    return {
      tools: collectiveEnabled ? [...TOOL_DEFINITIONS, ...COLLECTIVE_TOOL_DEFINITIONS] : TOOL_DEFINITIONS,
    };
  });

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
        const searchInput = input as {
          query: string;
          type?: string;
          limit?: number;
          observation_type?: string;
          status?: string;
          since?: number;
          until?: number;
          language?: string;
          path_prefix?: string;
        };
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
        const plansInput = input as {
          op?: 'list' | 'delete';
          id?: string;
          session?: string;
          status?: string;
          limit?: number;
          force_remote?: boolean;
        };
        const result = await handleMycoPlans(plansInput, client);
        const count = Array.isArray(result) ? result.length : undefined;
        logActivity(TOOL_PLANS, {
          op: plansInput.op ?? 'list',
          id: plansInput.id,
          session: plansInput.session,
          count,
          duration_ms: Date.now() - start,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_SAVE_PLAN: {
        const savePlanInput = input as {
          session_id: string;
          content: string;
          source_path?: string;
          plan_key?: string;
          title?: string;
          status?: string;
          tags?: string[];
        };
        const result = await handleMycoSavePlan(savePlanInput, client);
        logActivity(TOOL_SAVE_PLAN, {
          session_id: savePlanInput.session_id,
          source_path: savePlanInput.source_path,
          plan_key: savePlanInput.plan_key,
          duration_ms: Date.now() - start,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_SESSIONS: {
        const sessionsInput = input as {
          plan?: string; branch?: string; user?: string; since?: string;
          status?: string; limit?: number;
        };
        const result = await handleMycoSessions(sessionsInput, client);
        logActivity(TOOL_SESSIONS, { count: result.length, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_SUPERSEDE: {
        const supersedeInput = input as { old_spore_id: string; new_spore_id: string; reason?: string };
        const result = await handleMycoSupersede(supersedeInput, client);
        logActivity(TOOL_SUPERSEDE, { old: result.old_spore, new: result.new_spore, status: result.status, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_CONSOLIDATE: {
        const consolidateInput = input as {
          source_spore_ids: string[];
          consolidated_content: string;
          observation_type: string;
          tags?: string[];
          reason?: string;
        };
        const result = await handleMycoConsolidate(consolidateInput, client);
        logActivity(TOOL_CONSOLIDATE, {
          status: result.status,
          new_spore_id: result.new_spore_id,
          sources: result.sources_superseded.length,
          duration_ms: Date.now() - start,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_CONTEXT: {
        const contextInput = input as { tier?: number };
        const result = await handleMycoContext(contextInput, client);
        logActivity(TOOL_CONTEXT, { tier: contextInput.tier, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: result.content }] };
      }
      case TOOL_SKILLS: {
        const skillsInput = input as { id?: string; status?: string; limit?: number };
        const result = await handleMycoSkills(skillsInput, client);
        logActivity(TOOL_SKILLS, { id: skillsInput.id, status: skillsInput.status, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_COLLECTIVE_SEARCH: {
        const collectiveInput = input as {
          query: string;
          project?: string;
          limit?: number;
          types?: string[];
          status?: string;
          observation_type?: string;
          since?: number;
          until?: number;
          session_id?: string;
          source_path?: string;
          name?: string;
        };
        const result = await handleCollectiveSearch(collectiveInput, client);
        logActivity(TOOL_COLLECTIVE_SEARCH, { query: collectiveInput.query, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_COLLECTIVE_PROJECTS: {
        const result = await handleCollectiveProjects(client);
        logActivity(TOOL_COLLECTIVE_PROJECTS, { duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_COLLECTIVE_PROJECT: {
        const collectiveInput = input as { project: string; include_digest?: boolean };
        const result = await handleCollectiveProject(collectiveInput, client);
        logActivity(TOOL_COLLECTIVE_PROJECT, { project: collectiveInput.project, duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_COLLECTIVE_SETTINGS: {
        const result = await handleCollectiveSettings(client);
        logActivity(TOOL_COLLECTIVE_SETTINGS, { duration_ms: Date.now() - start });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case TOOL_RUNS: {
        const runsInput = input as {
          op?: 'list' | 'get';
          id?: string;
          task?: string;
          agent_id?: string;
          limit?: number;
        };
        const result = await handleMycoRuns(runsInput, client);
        logActivity(TOOL_RUNS, {
          op: runsInput.op ?? 'list',
          id: runsInput.id,
          ok: result.ok,
          duration_ms: Date.now() - start,
        });
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

export async function main(): Promise<void> {
  const vaultDir = resolveVaultDir();
  const client = new DaemonClient(vaultDir);
  const server = createMycoServer(vaultDir, client);
  await server.start();
}
