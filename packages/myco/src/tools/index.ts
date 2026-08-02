import fs from 'node:fs';
import path from 'node:path';
import type { DaemonClient } from '@myco/hooks/client.js';
import type { Database } from '@myco/db/client.js';
import { ToolError, isToolError } from './error.js';
import { isMutatingToolCall, assertProjectAdmitsToolWrite } from './lease-admission.js';
import { isCallerTenancy, requireProjectId, type MycoRequestContext } from '@myco/grove/request-context.js';
import {
  readPivot,
  resolveCallContext,
  stripPivotFields,
  type CallContextConstraint,
} from './call-context.js';
import { resolveDaemonLogDir } from '@myco/daemon/service-state.js';
import { resolveMycoHome } from '@myco/grove/paths.js';
import {
  TOOL_AGENT,
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
  requestContext?: MycoRequestContext;
  /**
   * Optional resolver for the per-request DB handle. When provided, tool
   * calls reuse the resolved (and cached) connection inside withDatabase
   * instead of opening a fresh one per call. CLI/standalone callers can
   * omit it — runWithRequestDatabase will fall back to opening + closing
   * a private handle, preserving existing behavior outside the daemon.
   */
  resolveDatabase?: (databasePath: string) => Database;
  callContextConstraint?: CallContextConstraint;
  /**
   * Myco home for the project write-admission lease read. Injected for
   * testability; production callers omit it and let `resolveMycoHome()`
   * find it from env/config, matching `resolveCallContext`'s convention.
   */
  mycoHome?: string;
  /**
   * Invocation channel of the caller: 'cli' when the request came from
   * `myco tool call` (declared via the x-myco-tool-transport header), else
   * 'mcp'. Governs whether instruction-shaped responses carry the CLI
   * transport directive.
   */
  toolCallerTransport?: 'cli' | 'mcp';
}

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

/**
 * Require a caller-supplied tenancy on the tools runtime.
 *
 * Every NON-UI transport (CLI from env, MCP from headers, the stdio bridge,
 * in-process agent runs) funnels through `createMycoTools`. A legitimate
 * transport hands us a context whose `tenancySource` is `'caller'` — the
 * project/grove identity was supplied by the caller and survived the
 * context-switch auth gate. An absent context, or one whose tenancy was
 * `'synthesized'` from the daemon's bootstrap-anchor vault, is the tool-layer
 * twin of the bootstrap-anchor leak: it silently derives tenancy from the
 * anchor instead of the caller. Reject it loudly with the same typed
 * `legacy_vault` code the MCP-HTTP layer already returns, so CLI and MCP
 * clients get a consistent, typed "this project context isn't authorized /
 * hasn't been auto-registered yet" error rather than a silent anchor default.
 *
 * Lives at the tools layer (not `daemon/request-principal.ts`) because
 * `tools/` is the shared runtime imported by daemon AND cli AND mcp; importing
 * the daemon principal here would be a layering violation.
 */
function requireCallerTenancy(context: MycoRequestContext | undefined): MycoRequestContext {
  if (!context || !isCallerTenancy(context)) {
    throw new ToolError(
      'legacy_vault',
      'Myco tools require a caller-supplied request context (project/Grove tenancy). '
      + 'No authorized tenancy was supplied; refusing to default to the bootstrap-anchor vault. '
      + 'CLI callers set MYCO_PROJECT_ID/MYCO_GROVE_ID; MCP callers send x-myco-project-id/x-myco-grove-id.',
    );
  }
  return context;
}

/**
 * Prefix an op:instructions body with the CLI transport directive. The
 * invocation resolves on THIS machine; a host-served request's response
 * crosses the overlay to another machine, so it renders the bare name.
 */
async function withCliTransportDirective(result: unknown, context?: MycoRequestContext): Promise<unknown> {
  if (!result || typeof result !== 'object') return result;
  const body = result as { content?: unknown };
  if (typeof body.content !== 'string' || !body.content.trim()) return result;
  const { cliToolTransportDirective } = await import('../context/cortex-injection-context.js');
  const { isHostServedRequest } = await import('../grove/request-context.js');
  const { resolveBinary } = await import('../runtime/binary-resolution.js');
  const invocation = isHostServedRequest(context)
    ? 'myco'
    : resolveBinary('instruction', { kind: 'machine' }).path;
  return { ...body, content: `${cliToolTransportDirective(invocation)}\n\n${body.content}` };
}

export function createMycoTools(vaultDir: string, client: DaemonClient, options: MycoToolsOptions = {}): MycoTools {
  let logDirReady = false;
  let logDirCache: string | null = null;

  // Resolve the daemon log dir lazily and only once we have a guarded
  // caller context — the previous eager `resolveRequestContextForVault`
  // fallback derived tenancy from the anchor vault at construction time.
  function resolveLogDir(context: MycoRequestContext): string {
    if (logDirCache === null) {
      logDirCache = resolveDaemonLogDir(vaultDir, { requestContext: context, env: process.env });
    }
    return logDirCache;
  }

  async function runWithRequestDatabase<T>(
    context: MycoRequestContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    const { openDatabase, withDatabase } = await import('@myco/db/client.js');
    const { createSchema, SchemaVersionTooNewError } = await import('@myco/db/schema.js');
    const { getMachineId } = await import('@myco/machine-id.js');
    if (options.resolveDatabase) {
      let db: Database;
      try {
        db = options.resolveDatabase(context.databasePath);
      } catch {
        throw new ToolError('tool_call_failed', 'Vault database is not available');
      }
      return withDatabase(db, fn);
    }
    const { isSchemaMigrationPending } = await import('@myco/db/schema.js');
    let db: Database;
    try {
      // Residual front-door hazard: outside the daemon (CLI `myco tool
      // call`), the BASE context's database opens in-process with no
      // home-ownership check — only cross-Grove `grove_id` pivots are
      // gated (resolveCallContext throws `foreign_grove`). Gating the base
      // context is tracked in the RC-5 remediation plan.
      db = openDatabase(context.databasePath);
    } catch {
      throw new ToolError('tool_call_failed', 'Vault database is not available');
    }
    // Refuse to MIGRATE a project that is mid-move, even for a read: the
    // op-level gate above admits reads because reading is harmless during a
    // transition, whereas running the migration chain alters tables under an
    // in-flight push.
    //
    // Reachability, stated honestly rather than implied: this branch runs
    // only when a caller builds `MycoTools` WITHOUT `resolveDatabase`, and
    // neither production wiring does — `mcp/http.ts` and
    // `daemon/external-listener.ts` both pass one, and the CLI is an MCP
    // client of `/mcp` rather than an in-process caller
    // (decision-14e572a3). So this guard is currently unreachable in
    // production and is NOT what makes the tool surface safe; the gate in
    // `callTool` is. It exists so that if an out-of-daemon caller is ever
    // re-added, it cannot migrate a leased project on its first call.
    //
    // Ordered so the cheap local version probe runs first: the lease read
    // costs nothing unless a migration is actually pending.
    try {
      if (context.projectId && isSchemaMigrationPending(db)) {
        assertProjectAdmitsToolWrite(context.projectId, options.mycoHome ?? resolveMycoHome());
      }
    } catch (err) {
      db.close();
      // Only the admission refusal travels as itself. A raw probe failure
      // (corrupt file, SQLITE_BUSY past the timeout) must still surface as
      // `tool_call_failed`: that exact code is what the Canopy dispatchers
      // key on to degrade to an empty map instead of erroring, and before
      // this branch existed the same statement threw from inside
      // createSchema's catch and got that conversion.
      if (isToolError(err)) throw err;
      throw new ToolError('tool_call_failed', 'Vault database is not available');
    }
    try {
      // Real machine id (not the 'local' default) so the v52 conversion runs.
      createSchema(db, getMachineId());
    } catch (err) {
      db.close();
      if (err instanceof SchemaVersionTooNewError) {
        // Don't flatten THIS one to the generic message: "your vault was
        // written by a newer Myco" names its own remediation (upgrade) and
        // flattening it cost a real diagnosis in the wild.
        throw new ToolError('tool_call_failed', err.message);
      }
      throw new ToolError('tool_call_failed', 'Vault database is not available');
    }
    try {
      return await withDatabase(db, fn);
    } finally {
      db.close();
    }
  }

  function normalizeInput(args: unknown): ToolInput {
    if (args === undefined || args === null) return {};
    if (typeof args === 'object' && !Array.isArray(args)) return args as ToolInput;
    throw new ToolError('invalid_input', 'Tool arguments must be a JSON object');
  }

  async function getAvailableDefinitions(): Promise<ToolDefinition[]> {
    return TOOL_DEFINITIONS;
  }

  async function getAvailableDefinition(name: string): Promise<ToolDefinition> {
    const available = await getAvailableDefinitions();
    const definition = available.find((tool) => tool.name === name);
    if (definition) return definition;
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

  function logActivity(context: MycoRequestContext, tool: string, detail: Record<string, unknown>): void {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      component: 'mcp',
      level: 'info',
      tool,
      ...detail,
    }) + '\n';
    try {
      const logDir = resolveLogDir(context);
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
        logActivity(context, TOOL_CORTEX, { op, tier: result.tier, fallback: result.fallback, duration_ms: Date.now() - start });
        return result;
      }
      case 'instructions': {
        const result = await cortex.handleCortexInstructions(client, context);
        logActivity(context, TOOL_CORTEX, { op, duration_ms: Date.now() - start });
        if (options.toolCallerTransport !== 'cli') return result;
        return withCliTransportDirective(result, context);
      }
      case 'canopy_entry':
        return await dispatchCanopyEntry(input, context, start, cortex.handleCortexCanopyEntry);
      case 'canopy_map':
        return await dispatchCanopyMap(input, context, start, cortex.handleCortexCanopyMap);
      case 'notifications': {
        const result = await cortex.handleCortexNotifications(input as unknown as Parameters<typeof cortex.handleCortexNotifications>[0], client, context);
        logActivity(context, TOOL_CORTEX, { op, duration_ms: Date.now() - start });
        return result;
      }
      case 'maintenance_summary': {
        const result = await cortex.handleCortexMaintenanceSummary(client, context);
        logActivity(context, TOOL_CORTEX, { op, duration_ms: Date.now() - start });
        return result;
      }
      case 'projects_activity': {
        const result = await cortex.handleCortexProjectsActivity(client, context);
        logActivity(context, TOOL_CORTEX, { op, duration_ms: Date.now() - start });
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
        logActivity(context, TOOL_CORTEX, { op: 'canopy_entry', id: input.id, project_id: context.projectId, path: input.path, duration_ms: Date.now() - start });
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
        const projectId = requireProjectId(context, 'cortex canopy map');
        const machineId = context.machineId;
        const sessionId = context.sessionId;
        const result = await handleCortexCanopyMap({ projectId, machineId });
        logActivity(context, TOOL_CORTEX, {
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
   */
  function effectiveContextFor(base: MycoRequestContext, _name: string, input: ToolInput): MycoRequestContext {
    return resolveCallContext(base, readPivot(input), {
      constraint: options.callContextConstraint,
      // Same lease store the front-door gate reads. Without this the pivot's
      // own admission check resolved MYCO_HOME independently, so a single
      // call could consult two different stores whenever a home is injected.
      ...(options.mycoHome === undefined ? {} : { mycoHome: options.mycoHome }),
    });
  }

  return {
    async listTools() {
      return getAvailableDefinitions();
    },

    getRegisteredTools() {
      return TOOL_DEFINITIONS.map((tool) => tool.name);
    },

    async callTool(name: string, args?: unknown): Promise<unknown> {
      // Every tool call needs caller-supplied tenancy. Reject absent /
      // synthesized contexts loudly before any DB or scope resolution so a
      // caller can never silently default to the bootstrap-anchor vault.
      const base = requireCallerTenancy(options.requestContext);
      const input = normalizeInput(args);
      const definition = await getAvailableDefinition(name);
      validateInput(definition, input);
      const start = Date.now();
      const context = effectiveContextFor(base, name, input);

      // Project write admission (write-admission phase 6). `/mcp` is a RAW
      // route: `DaemonServer.handleRequest` dispatches raw routes and
      // returns before the central per-project pause gate, so EVERY tool
      // call — CLI, MCP, overlay — arrives here having never crossed it. A
      // mutating call into a leased project would write into the source
      // Grove during a residency push and be deleted unshipped by
      // `deleteAfterAck`.
      //
      // Consulted on the EFFECTIVE context, after `effectiveContextFor`, so
      // it covers a call pivoted onto another project as well as the base
      // one. (`resolveCallContext` already refuses an explicit pivot onto a
      // leased project; this is the same answer for the un-pivoted case,
      // which that check never saw.)
      //
      // Reads are admitted: an agent mid-transition can still search, read
      // its plans and spores, and pull Cortex context.
      if (context.projectId && isMutatingToolCall(name, input)) {
        assertProjectAdmitsToolWrite(context.projectId, options.mycoHome ?? resolveMycoHome());
      }

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
      logActivity(context, name, {
        ...(entry.summarize?.(handlerInput, result) ?? {}),
        duration_ms: Date.now() - start,
      });
      return result;
    },
  };
}
