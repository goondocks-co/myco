import fs from 'node:fs';
import path from 'node:path';
import type { DaemonClient } from '@myco/hooks/client.js';
import { initDatabase, vaultDbPath } from '@myco/db/client.js';
import { resolveCanopyProjectId } from '@myco/canopy/identity.js';
import { getMachineId } from '@myco/daemon/machine-id.js';
import { incrementCanopyMapToolCalls } from '@myco/db/queries/sessions.js';
import { ToolError } from './error.js';
import { handleCanopyMap } from './canopy-map.js';
import {
  handleCollectiveProject,
  handleCollectiveProjects,
  handleCollectiveSearch,
  handleCollectiveSettings,
} from './collective.js';
import { handleMycoConsolidate } from './consolidate.js';
import { handleMycoContext } from './context.js';
import { handleMycoPlans } from './plans.js';
import { handleMycoRecall } from './recall.js';
import { handleMycoRemember } from './remember.js';
import { handleMycoRuns } from './runs.js';
import { handleMycoSavePlan } from './save-plan.js';
import { handleMycoSearch } from './search.js';
import { handleMycoSessions } from './sessions.js';
import { handleMycoSkills } from './skills.js';
import { handleMycoSupersede } from './supersede.js';
import {
  COLLECTIVE_TOOL_DEFINITIONS,
  TOOL_CANOPY_MAP,
  TOOL_COLLECTIVE_PROJECT,
  TOOL_COLLECTIVE_PROJECTS,
  TOOL_COLLECTIVE_SEARCH,
  TOOL_COLLECTIVE_SETTINGS,
  TOOL_CONSOLIDATE,
  TOOL_CONTEXT,
  TOOL_DEFINITIONS,
  TOOL_PLANS,
  TOOL_RECALL,
  TOOL_REMEMBER,
  TOOL_RUNS,
  TOOL_SAVE_PLAN,
  TOOL_SEARCH,
  TOOL_SESSIONS,
  TOOL_SKILLS,
  TOOL_SUPERSEDE,
  type ToolDefinition,
} from './definitions.js';

export interface MycoTools {
  listTools(): Promise<ToolDefinition[]>;
  getRegisteredTools(): string[];
  callTool(name: string, args?: unknown): Promise<unknown>;
}

export interface MycoToolsOptions {
  collectiveEnabled?: () => Promise<boolean>;
}

const COLLECTIVE_TOOL_NAMES = new Set(COLLECTIVE_TOOL_DEFINITIONS.map((tool) => tool.name));

interface JsonSchemaProperty {
  type?: string | readonly string[];
  enum?: readonly unknown[];
  items?: JsonSchemaProperty;
}

export function createMycoTools(vaultDir: string, client: DaemonClient, options: MycoToolsOptions = {}): MycoTools {
  let dbReady = false;
  let logDirReady = false;
  const logDir = path.join(vaultDir, 'logs');

  function ensureDb(): boolean {
    if (dbReady) return true;
    try {
      initDatabase(vaultDbPath(vaultDir));
      dbReady = true;
      return true;
    } catch {
      return false;
    }
  }

  async function collectiveEnabled(): Promise<boolean> {
    if (options.collectiveEnabled) return options.collectiveEnabled();
    try {
      const teamStatus = await client.get('/api/team/status');
      return Boolean(teamStatus.ok && teamStatus.data?.collective_connected);
    } catch {
      return false;
    }
  }

  function normalizeInput(args: unknown): Record<string, unknown> {
    if (args === undefined || args === null) return {};
    if (typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
    throw new ToolError('invalid_input', 'Tool arguments must be a JSON object');
  }

  async function getAvailableDefinitions(): Promise<ToolDefinition[]> {
    return await collectiveEnabled()
      ? [...TOOL_DEFINITIONS, ...COLLECTIVE_TOOL_DEFINITIONS]
      : TOOL_DEFINITIONS;
  }

  async function getAvailableDefinition(name: string): Promise<ToolDefinition> {
    const available = await getAvailableDefinitions();
    const definition = available.find((tool) => tool.name === name);
    if (definition) return definition;
    if (COLLECTIVE_TOOL_NAMES.has(name)) {
      throw new ToolError('tool_unavailable', `Tool unavailable: ${name}`);
    }
    throw new ToolError('unknown_tool', `Unknown tool: ${name}`);
  }

  function validateInput(definition: ToolDefinition, input: Record<string, unknown>): void {
    for (const key of definition.inputSchema.required ?? []) {
      if (input[key] === undefined || input[key] === null) {
        throw new ToolError('invalid_input', `Missing required argument '${key}' for tool ${definition.name}`);
      }
    }

    for (const [key, value] of Object.entries(input)) {
      const property = definition.inputSchema.properties[key] as JsonSchemaProperty | undefined;
      if (!property || value === undefined) continue;
      validateSchemaProperty(definition.name, key, value, property);
    }
  }

  function validateSchemaProperty(tool: string, key: string, value: unknown, property: JsonSchemaProperty): void {
    if (value === null) {
      throw new ToolError('invalid_input', `Invalid argument '${key}' for tool ${tool}: expected ${formatExpectedType(property)}`);
    }

    if (property.enum && !property.enum.includes(value)) {
      throw new ToolError('invalid_input', `Invalid argument '${key}' for tool ${tool}: expected one of ${property.enum.map(String).join(', ')}`);
    }

    const expectedTypes = typeof property.type === 'string'
      ? [property.type]
      : property.type ?? [];
    if (expectedTypes.length > 0 && !expectedTypes.some((type) => matchesJsonType(value, type))) {
      throw new ToolError('invalid_input', `Invalid argument '${key}' for tool ${tool}: expected ${formatExpectedType(property)}`);
    }

    if (expectedTypes.includes('array') && property.items && Array.isArray(value)) {
      value.forEach((item, index) => {
        validateSchemaProperty(tool, `${key}[${index}]`, item, property.items!);
      });
    }
  }

  function matchesJsonType(value: unknown, type: string): boolean {
    switch (type) {
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'integer': return typeof value === 'number' && Number.isInteger(value);
      case 'boolean': return typeof value === 'boolean';
      case 'array': return Array.isArray(value);
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'null': return value === null;
      default: return true;
    }
  }

  function formatExpectedType(property: JsonSchemaProperty): string {
    if (property.enum) return `one of ${property.enum.map(String).join(', ')}`;
    if (typeof property.type === 'string') return property.type;
    if (property.type) return property.type.join(' or ');
    return 'a valid value';
  }

  function logActivity(tool: string, detail: Record<string, unknown>): void {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      component: 'mcp',
      level: 'info',
      tool,
      ...detail,
    }) + '\n';
    try {
      if (!logDirReady) {
        fs.mkdirSync(logDir, { recursive: true });
        logDirReady = true;
      }
      fs.appendFile(path.join(logDir, 'mcp.jsonl'), entry, () => { /* non-fatal */ });
    } catch { /* logging failure is non-fatal */ }

    void client.post('/api/log', { level: 'info', component: 'mcp', message: `Tool call: ${tool}`, data: { tool, ...detail } }).catch(() => { /* non-fatal */ });
  }

  return {
    async listTools() {
      return getAvailableDefinitions();
    },

    getRegisteredTools() {
      return TOOL_DEFINITIONS.map((tool) => tool.name);
    },

    async callTool(name: string, args?: unknown): Promise<unknown> {
      const input = normalizeInput(args);
      const definition = await getAvailableDefinition(name);
      validateInput(definition, input);
      const start = Date.now();

      switch (name) {
        case TOOL_SEARCH: {
          const result = await handleMycoSearch(input as unknown as Parameters<typeof handleMycoSearch>[0], client);
          logActivity(TOOL_SEARCH, { query: input.query, matches: result.length, duration_ms: Date.now() - start });
          return result;
        }
        case TOOL_RECALL: {
          const result = await handleMycoRecall(input as unknown as Parameters<typeof handleMycoRecall>[0], client);
          logActivity(TOOL_RECALL, { note_id: input.note_id, duration_ms: Date.now() - start });
          return result;
        }
        case TOOL_REMEMBER: {
          const result = await handleMycoRemember(input as unknown as Parameters<typeof handleMycoRemember>[0], client);
          logActivity(TOOL_REMEMBER, { id: result.id, observation_type: result.observation_type, duration_ms: Date.now() - start });
          return result;
        }
        case TOOL_PLANS: {
          const result = await handleMycoPlans(input as unknown as Parameters<typeof handleMycoPlans>[0], client);
          const count = Array.isArray(result) ? result.length : undefined;
          logActivity(TOOL_PLANS, {
            op: input.op ?? 'list',
            id: input.id,
            session: input.session,
            count,
            duration_ms: Date.now() - start,
          });
          return result;
        }
        case TOOL_SAVE_PLAN: {
          const result = await handleMycoSavePlan(input as unknown as Parameters<typeof handleMycoSavePlan>[0], client);
          logActivity(TOOL_SAVE_PLAN, {
            session_id: input.session_id,
            source_path: input.source_path,
            plan_key: input.plan_key,
            duration_ms: Date.now() - start,
          });
          return result;
        }
        case TOOL_SESSIONS: {
          const result = await handleMycoSessions(input as unknown as Parameters<typeof handleMycoSessions>[0], client);
          logActivity(TOOL_SESSIONS, { count: result.length, duration_ms: Date.now() - start });
          return result;
        }
        case TOOL_SUPERSEDE: {
          const result = await handleMycoSupersede(input as unknown as Parameters<typeof handleMycoSupersede>[0], client);
          logActivity(TOOL_SUPERSEDE, { old: result.old_spore, new: result.new_spore, status: result.status, duration_ms: Date.now() - start });
          return result;
        }
        case TOOL_CONSOLIDATE: {
          const result = await handleMycoConsolidate(input as unknown as Parameters<typeof handleMycoConsolidate>[0], client);
          logActivity(TOOL_CONSOLIDATE, {
            status: result.status,
            new_spore_id: result.new_spore_id,
            sources: result.sources_superseded.length,
            duration_ms: Date.now() - start,
          });
          return result;
        }
        case TOOL_CONTEXT: {
          const result = await handleMycoContext(input as unknown as Parameters<typeof handleMycoContext>[0], client);
          logActivity(TOOL_CONTEXT, { tier: input.tier, duration_ms: Date.now() - start });
          return result;
        }
        case TOOL_SKILLS: {
          const result = await handleMycoSkills(input as unknown as Parameters<typeof handleMycoSkills>[0], client);
          logActivity(TOOL_SKILLS, { id: input.id, status: input.status, duration_ms: Date.now() - start });
          return result;
        }
        case TOOL_COLLECTIVE_SEARCH: {
          const result = await handleCollectiveSearch(input as unknown as Parameters<typeof handleCollectiveSearch>[0], client);
          logActivity(TOOL_COLLECTIVE_SEARCH, { query: input.query, duration_ms: Date.now() - start });
          return result;
        }
        case TOOL_COLLECTIVE_PROJECTS: {
          const result = await handleCollectiveProjects(client);
          logActivity(TOOL_COLLECTIVE_PROJECTS, { duration_ms: Date.now() - start });
          return result;
        }
        case TOOL_COLLECTIVE_PROJECT: {
          const result = await handleCollectiveProject(input as unknown as Parameters<typeof handleCollectiveProject>[0], client);
          logActivity(TOOL_COLLECTIVE_PROJECT, { project: input.project, duration_ms: Date.now() - start });
          return result;
        }
        case TOOL_COLLECTIVE_SETTINGS: {
          const result = await handleCollectiveSettings(client);
          logActivity(TOOL_COLLECTIVE_SETTINGS, { duration_ms: Date.now() - start });
          return result;
        }
        case TOOL_RUNS: {
          const result = await handleMycoRuns(input as unknown as Parameters<typeof handleMycoRuns>[0], client);
          logActivity(TOOL_RUNS, {
            op: input.op ?? 'list',
            id: input.id,
            ok: result.ok,
            duration_ms: Date.now() - start,
          });
          return result;
        }
        case TOOL_CANOPY_MAP: {
          if (!ensureDb()) {
            return {
              content: '',
              is_empty: true,
              message: 'Vault database is not available; the canopy map cannot be read right now.',
            };
          }
          const projectId = resolveCanopyProjectId(vaultDir);
          const machineId = process.env.MYCO_MACHINE_ID ?? getMachineId(vaultDir);
          const sessionId = process.env.MYCO_SESSION_ID ?? null;
          const result = await handleCanopyMap({ projectId, machineId });
          if (sessionId) {
            try { incrementCanopyMapToolCalls(sessionId); } catch { /* counter is best-effort */ }
          }
          logActivity(TOOL_CANOPY_MAP, {
            is_empty: result.is_empty === true,
            token_estimate: result.token_estimate,
            session_id: sessionId,
            duration_ms: Date.now() - start,
          });
          return result;
        }
        default:
          throw new ToolError('unknown_tool', `Unknown tool: ${name}`);
      }
    },
  };
}
