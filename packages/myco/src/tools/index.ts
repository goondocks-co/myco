import fs from 'node:fs';
import path from 'node:path';
import type { DaemonClient } from '@myco/hooks/client.js';
import type { Database } from '@myco/db/client.js';
import { ToolError } from './error.js';
import { isCollectiveEnabled } from './shared.js';
import {
  resolveRequestContextForVault,
  type MycoRequestContext,
} from './request-context.js';
import {
  readPivot,
  resolveCallContext,
  stripPivotFields,
} from './call-context.js';
import { resolveDaemonLogDir } from '@myco/daemon/service-state.js';
import {
  COLLECTIVE_TOOL_DEFINITIONS,
  TOOL_AGENT,
  TOOL_COLLECTIVE_PROJECT,
  TOOL_COLLECTIVE_PROJECTS,
  TOOL_COLLECTIVE_SEARCH,
  TOOL_COLLECTIVE_SETTINGS,
  TOOL_CORTEX,
  TOOL_DEFINITIONS,
  TOOL_PLANS,
  TOOL_SEARCH,
  TOOL_SESSIONS,
  TOOL_SKILLS,
  TOOL_SPORES,
  type ToolDefinition,
} from './definitions.js';

export interface MycoTools {
  listTools(): Promise<ToolDefinition[]>;
  getRegisteredTools(): string[];
  callTool(name: string, args?: unknown): Promise<unknown>;
}

export interface MycoToolsOptions {
  collectiveEnabled?: () => Promise<boolean>;
  requestContext?: MycoRequestContext;
  /**
   * Optional resolver for the per-request DB handle. When provided, tool
   * calls reuse the resolved (and cached) connection inside withDatabase
   * instead of opening a fresh one per call. CLI/standalone callers can
   * omit it — runWithRequestDatabase will fall back to opening + closing
   * a private handle, preserving existing behavior outside the daemon.
   */
  resolveDatabase?: (databasePath: string) => Database;
}

const COLLECTIVE_TOOL_NAMES = new Set(COLLECTIVE_TOOL_DEFINITIONS.map((tool) => tool.name));

interface JsonSchemaProperty {
  type?: string | readonly string[];
  enum?: readonly unknown[];
  items?: JsonSchemaProperty;
}

type ToolInput = Record<string, unknown>;

interface ToolEntry {
  handle: (input: ToolInput, client: DaemonClient, context: MycoRequestContext) => Promise<unknown>;
  summarize?: (input: ToolInput, result: unknown) => Record<string, unknown>;
}

type ToolLoader = () => Promise<ToolEntry>;

// myco_cortex is dispatched separately for Canopy ops: they need vault DB
// init, env vars, and a session counter that the table contract doesn't carry.
const HANDLERS = new Map<string, ToolLoader>([
  [TOOL_SEARCH, async () => {
    const { handleMycoSearch } = await import('./search.js');
    return {
      handle: (input, client, context) => handleMycoSearch(input as unknown as Parameters<typeof handleMycoSearch>[0], client, context),
      summarize: (input, result) => ({ query: input.query, matches: (result as unknown[]).length }),
    };
  }],
  [TOOL_PLANS, async () => {
    const { handleMycoPlans } = await import('./plans.js');
    return {
      handle: (input, client, context) => handleMycoPlans(input as unknown as Parameters<typeof handleMycoPlans>[0], client, context),
      summarize: (input, result) => ({
        op: input.op ?? 'list',
        id: input.id,
        session: input.session,
        count: Array.isArray(result) ? result.length : undefined,
      }),
    };
  }],
  [TOOL_SESSIONS, async () => {
    const { handleMycoSessions } = await import('./sessions.js');
    return {
      handle: (input, client, context) => handleMycoSessions(input as unknown as Parameters<typeof handleMycoSessions>[0], client, context),
      summarize: (input, result) => ({ op: input.op ?? 'list', id: input.id, count: Array.isArray(result) ? result.length : undefined }),
    };
  }],
  [TOOL_SKILLS, async () => {
    const { handleMycoSkills } = await import('./skills.js');
    return {
      handle: (input, client, context) => handleMycoSkills(input as unknown as Parameters<typeof handleMycoSkills>[0], client, context),
      summarize: (input) => ({ op: input.op ?? 'list', id: input.id, status: input.status }),
    };
  }],
  [TOOL_SPORES, async () => {
    const { handleMycoSpores } = await import('./spores.js');
    return {
      handle: (input, client, context) => handleMycoSpores(input as unknown as Parameters<typeof handleMycoSpores>[0], client, context),
      summarize: (input, result) => {
        const r = result as { id?: unknown; observation_type?: unknown; spores?: unknown[]; status?: unknown };
        return {
          op: input.op ?? 'list',
          id: input.id ?? r.id,
          observation_type: input.observation_type ?? input.type ?? r.observation_type,
          count: Array.isArray(r.spores) ? r.spores.length : undefined,
          status: r.status,
        };
      },
    };
  }],
  [TOOL_COLLECTIVE_SEARCH, async () => {
    const { handleCollectiveSearch } = await import('./collective.js');
    return {
      handle: (input, client) => handleCollectiveSearch(input as unknown as Parameters<typeof handleCollectiveSearch>[0], client),
      summarize: (input) => ({ query: input.query }),
    };
  }],
  [TOOL_COLLECTIVE_PROJECTS, async () => {
    const { handleCollectiveProjects } = await import('./collective.js');
    return {
      handle: (_input, client) => handleCollectiveProjects(client),
    };
  }],
  [TOOL_COLLECTIVE_PROJECT, async () => {
    const { handleCollectiveProject } = await import('./collective.js');
    return {
      handle: (input, client) => handleCollectiveProject(input as unknown as Parameters<typeof handleCollectiveProject>[0], client),
      summarize: (input) => ({ project: input.project }),
    };
  }],
  [TOOL_COLLECTIVE_SETTINGS, async () => {
    const { handleCollectiveSettings } = await import('./collective.js');
    return {
      handle: (_input, client) => handleCollectiveSettings(client),
    };
  }],
  [TOOL_AGENT, async () => {
    const { handleMycoAgent } = await import('./agent.js');
    return {
      handle: (input, client, context) => handleMycoAgent(input as unknown as Parameters<typeof handleMycoAgent>[0], client, context),
      summarize: (input, result) => {
        const r = result as { ok: unknown };
        return { op: input.op ?? 'runs', id: input.id, ok: r.ok };
      },
    };
  }],
]);

export function createMycoTools(vaultDir: string, client: DaemonClient, options: MycoToolsOptions = {}): MycoTools {
  let logDirReady = false;
  let collectiveProbe: Promise<boolean> | null = null;
  const requestContext = options.requestContext ?? resolveRequestContextForVault(vaultDir);
  const logDir = resolveDaemonLogDir(vaultDir, { requestContext, env: process.env });

  async function runWithRequestDatabase<T>(
    context: MycoRequestContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    const { openDatabase, withDatabase } = await import('@myco/db/client.js');
    const { createSchema } = await import('@myco/db/schema.js');
    if (options.resolveDatabase) {
      let db: Database;
      try {
        db = options.resolveDatabase(context.databasePath);
      } catch {
        throw new ToolError('tool_call_failed', 'Vault database is not available');
      }
      return withDatabase(db, fn);
    }
    let db: Database;
    try {
      db = openDatabase(context.databasePath);
      createSchema(db);
    } catch {
      throw new ToolError('tool_call_failed', 'Vault database is not available');
    }
    try {
      return await withDatabase(db, fn);
    } finally {
      db.close();
    }
  }

  // Memoize per-instance: the dispatcher hits this on every callTool, and
  // the collective flag is stable for the lifetime of a tools instance.
  function collectiveEnabled(): Promise<boolean> {
    if (options.collectiveEnabled) return options.collectiveEnabled();
    if (!collectiveProbe) collectiveProbe = isCollectiveEnabled(client);
    return collectiveProbe;
  }

  function normalizeInput(args: unknown): ToolInput {
    if (args === undefined || args === null) return {};
    if (typeof args === 'object' && !Array.isArray(args)) return args as ToolInput;
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

  function validateInput(definition: ToolDefinition, input: ToolInput): void {
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
      // Synchronous write: tool calls happen at human/agent pace (not a hot
      // loop), entries are ~1 KB, and downstream readers (tests + daemon
      // tailing) assume an entry is on disk by the time the caller's await
      // resolves. The previous async fs.appendFile + ignored callback
      // produced a write-after-read race that surfaced as flaky test
      // failures whenever larger suite ordering shifted timing.
      fs.appendFileSync(path.join(logDir, 'mcp.jsonl'), entry);
    } catch { /* logging failure is non-fatal */ }

    void client.post('/api/log', { level: 'info', component: 'mcp', message: `Tool call: ${tool}`, data: { tool, ...detail } }).catch(() => { /* non-fatal */ });
  }

  async function dispatchCortex(
    input: ToolInput,
    context: MycoRequestContext,
    start: number,
  ): Promise<unknown> {
    const op = input.op ?? 'digest';
    const cortex = await import('./cortex.js');

    switch (op) {
      case 'digest': {
        const result = await cortex.handleCortexDigest(input as unknown as Parameters<typeof cortex.handleCortexDigest>[0], client, context);
        logActivity(TOOL_CORTEX, { op, tier: result.tier, fallback: result.fallback, duration_ms: Date.now() - start });
        return result;
      }
      case 'instructions': {
        const result = await cortex.handleCortexInstructions(client, context);
        logActivity(TOOL_CORTEX, { op, duration_ms: Date.now() - start });
        return result;
      }
      case 'canopy_entry':
        return await dispatchCanopyEntry(input, context, start, cortex.handleCortexCanopyEntry);
      case 'canopy_map':
        return await dispatchCanopyMap(input, context, start, cortex.handleCortexCanopyMap);
      case 'notifications': {
        const result = await cortex.handleCortexNotifications(input as unknown as Parameters<typeof cortex.handleCortexNotifications>[0], client, context);
        logActivity(TOOL_CORTEX, { op, duration_ms: Date.now() - start });
        return result;
      }
      case 'maintenance_summary': {
        const result = await cortex.handleCortexMaintenanceSummary(client, context);
        logActivity(TOOL_CORTEX, { op, duration_ms: Date.now() - start });
        return result;
      }
      case 'projects_activity': {
        const result = await cortex.handleCortexProjectsActivity(client, context);
        logActivity(TOOL_CORTEX, { op, duration_ms: Date.now() - start });
        return result;
      }
      default:
        throw new ToolError('invalid_input', `Unknown op '${String(op)}' for tool ${TOOL_CORTEX}`);
    }
  }

  async function dispatchCanopyEntry(
    input: ToolInput,
    context: MycoRequestContext,
    start: number,
    handleCortexCanopyEntry: typeof import('./cortex.js')['handleCortexCanopyEntry'],
  ): Promise<unknown> {
    try {
      return await runWithRequestDatabase(context, async () => {
        const result = await handleCortexCanopyEntry(
          input as unknown as Parameters<typeof handleCortexCanopyEntry>[0],
          context,
        );
        logActivity(TOOL_CORTEX, { op: 'canopy_entry', id: input.id, project_id: context.projectId, path: input.path, duration_ms: Date.now() - start });
        return result;
      });
    } catch (err) {
      if (!(err instanceof ToolError) || err.code !== 'tool_call_failed') throw err;
      const { emptyCanopyMap } = await import('./canopy-map.js');
      return emptyCanopyMap('Vault database is not available; Canopy data cannot be read right now.');
    }
  }

  async function dispatchCanopyMap(
    input: ToolInput,
    context: MycoRequestContext,
    start: number,
    handleCortexCanopyMap: typeof import('./cortex.js')['handleCortexCanopyMap'],
  ): Promise<unknown> {
    // Per-session canopy_map counts are derived from `activities` at Stop
    // boundary by `materializeSessionMycoToolCalls` (see
    // db/queries/myco-tool-usage.ts), not incremented at dispatch. The prior
    // dispatch-time increment depended on `context.sessionId` being supplied
    // by the transport and silently produced zeros for several symbionts —
    // see plan session:3216054f...:key:myco-tool-call-tracking-per-session.
    try {
      return await runWithRequestDatabase(context, async () => {
        const projectId = context.projectId;
        const machineId = context.machineId;
        const sessionId = context.sessionId;
        const result = await handleCortexCanopyMap({ projectId, machineId });
        logActivity(TOOL_CORTEX, {
          op: 'canopy_map',
          is_empty: (result as { is_empty?: boolean }).is_empty === true,
          token_estimate: (result as { token_estimate?: number }).token_estimate,
          session_id: sessionId,
          duration_ms: Date.now() - start,
        });
        return result;
      });
    } catch (err) {
      if (!(err instanceof ToolError) || err.code !== 'tool_call_failed') throw err;
      const { emptyCanopyMap } = await import('./canopy-map.js');
      return emptyCanopyMap('Vault database is not available; Canopy data cannot be read right now.');
    }
  }

  /**
   * Resolve the effective request context for one tool call. When the
   * input carries `grove_id` and/or `project_id` (J3), pivot scope per
   * the call-context resolver. Otherwise return the closed-over base
   * context unchanged.
   *
   * Tools that don't accept scope-pivot fields (`collective_*`) skip
   * resolution — those fields aren't in their schemas, so they were
   * already rejected by `validateInput`.
   */
  function effectiveContextFor(name: string, input: ToolInput): MycoRequestContext {
    if (name.startsWith('collective_')) return requestContext;
    return resolveCallContext(requestContext, readPivot(input));
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
      const context = effectiveContextFor(name, input);
      // Pivot fields are dispatcher-only; strip them so handlers can't
      // accidentally forward them as URL query params or row filters.
      const handlerInput = stripPivotFields(input);

      if (name === TOOL_CORTEX) {
        return dispatchCortex(handlerInput, context, start);
      }

      const loader = HANDLERS.get(name);
      if (!loader) throw new ToolError('unknown_tool', `Unknown tool: ${name}`);
      const entry = await loader();
      const result = await runWithRequestDatabase(context, () => entry.handle(handlerInput, client, context));
      logActivity(name, {
        ...(entry.summarize?.(handlerInput, result) ?? {}),
        duration_ms: Date.now() - start,
      });
      return result;
    },
  };
}
