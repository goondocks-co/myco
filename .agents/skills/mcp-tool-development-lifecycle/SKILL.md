---
name: myco:mcp-tool-development-lifecycle
description: |
  Comprehensive lifecycle for authoring, registering, documenting, and maintaining MCP tools in packages/myco/src/tools/ — covering schema definition in TOOL_DEFINITIONS arrays, handler implementation with DaemonClient patterns, shared tool-runtime registration, documentation bundling, anti-drift testing patterns, and cloud vs local placement decisions. Essential for maintaining the schema ↔ handler ↔ documentation triad that agents depend on for correct tool invocations, even when the user doesn't explicitly ask for MCP tool development.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# MCP Tool Development and Anti-Drift Maintenance

MCP tools are the primary interface between agents and the Myco intelligence pipeline. Each tool requires a coordinated schema ↔ handler ↔ documentation triad that can drift over time, causing silent agent failures. This skill covers the complete development lifecycle and maintenance procedures to prevent drift regressions.

## Prerequisites

- Working Myco development environment with `packages/myco/src/tools/` structure
- Understanding of JSON Schema for parameter definitions
- Familiarity with TypeScript handler patterns and DaemonClient usage
- Knowledge of local vs cloud MCP bifurcation model
- Understanding of shared tool-runtime supporting multiple transports (MCP stdio, HTTP MCP, CLI)

## Procedure A: Schema Definition

Define the tool interface in `packages/myco/src/tools/definitions.ts` (shared tool-runtime definitions):

1. **Add tool name constant** at the top of the file:
   ```typescript
   export const TOOL_MY_NEW_TOOL = 'myco_my_new_tool';
   ```

2. **Add schema entry** to the appropriate array (`TOOL_DEFINITIONS` for local tools, `COLLECTIVE_TOOL_DEFINITIONS` for Collective-dependent tools):
   ```typescript
   {
     name: TOOL_MY_NEW_TOOL,
     description: 'Brief description of what this tool does — agents use this for selection decisions',
     cortex: {
       guidance: 'Clear guidance for when to use this tool vs alternatives',
       priority: 50, // Default 100, lower numbers = higher priority
       requiresTeam: false, // Set true if requires team sync
       requiresCollective: false, // Set true if requires Collective connection
     },
     annotations: {
       readOnlyHint: true, // False if tool mutates state
       destructiveHint: false, // True if tool can destroy data
       idempotentHint: true, // False if repeated calls cause different effects
       openWorldHint: false, // True if tool reaches outside local vault
     },
     inputSchema: {
       type: 'object' as const,
       properties: {
         param_name: {
           type: 'string',
           description: 'Clear description for agents — include format examples'
         },
         optional_param: {
           type: 'number',
           description: 'Optional parameter with default behavior explained'
         }
       },
       required: ['param_name']
     }
   }
   ```

3. **Use descriptive parameter names** — agents rely on semantic meaning. `session_id` is better than `id`, `batch_limit` is better than `limit`.

4. **Document every parameter thoroughly** — the description is what agents use to understand usage. Include examples for complex formats.

5. **Set annotations correctly** — `readOnlyHint: true` for read-only tools, `destructiveHint: true` for tools that can destroy data.

6. **Configure cortex metadata** — set `requiresCollective: true` for tools that only work when connected to a Collective.

7. **Avoid OpenAI strict mode incompatibilities** — OpenAI's strict JSON Schema mode rejects `oneOf`, `anyOf`, `allOf`, `enum`, and `not` keywords at the top level. Use simple types with clear descriptions instead:
   ```typescript
   // BAD: OpenAI strict mode rejects this
   {
     param_status: {
       enum: ['active', 'inactive', 'pending'],
       description: 'Status value'
     }
   }

   // GOOD: Use string with enum values in description
   {
     param_status: {
       type: 'string',
       description: 'Status value. Must be one of: active, inactive, pending'
     }
   }
   ```

8. **Avoid Zod refinement-like patterns** — Schema constructs that imply Zod refinements cause silent tool registration failures across runtimes. Never use `.default()`, `.min()`, `.max()`, or `.refine()` patterns in schema definitions:
   ```typescript
   // BAD: Implies Zod refinements that cause registration failures
   {
     limit: {
       type: 'number',
       default: 10,        // Zod .default() - causes registration failure
       minimum: 1,         // Zod .min() - causes registration failure
       maximum: 100        // Zod .max() - causes registration failure
     }
   }

   // GOOD: Use plain schema with behavior described in documentation
   {
     limit: {
       type: 'number',
       description: 'Maximum items to return (1-100, defaults to 10 if omitted)'
     }
   }
   ```

## Procedure B: Handler Implementation

Create the handler in `packages/myco/src/tools/my-new-tool.ts`:

1. **Import required types and client**:
   ```typescript
   import type { DaemonClient } from '@myco/hooks/client.js';
   import { buildEndpoint } from './shared.js';
   import { ToolFailure } from './error.js';
   ```

2. **Define input and result types**:
   ```typescript
   interface MyNewToolInput {
     param_name: string;
     optional_param?: number;
   }

   interface MyNewToolResult {
     id: string;
     status: string;
     // ... other result fields
   }
   ```

3. **Implement the handler function with canonical error handling**:
   ```typescript
   export async function handleMyNewTool(
     input: MyNewToolInput,
     client: DaemonClient,
   ): Promise<MyNewToolResult> {
     // Validate all schema-declared parameters are consumed
     const { param_name, optional_param = defaultValue } = input;

     try {
       const endpoint = buildEndpoint('/api/some-operation', {
         param_name,
         optional_param,
       });

       const response = await client.get(endpoint);
       return response as MyNewToolResult;
     } catch (error) {
       // Use ToolFailure for consistent agent-facing error structure
       throw new ToolFailure(`Failed to execute ${TOOL_MY_NEW_TOOL}`, {
         cause: error,
         context: { param_name, optional_param },
         retriable: true, // Set false for permanent failures
       });
     }
   }
   ```

4. **Consume every schema parameter** — handlers must accept exactly what the schema advertises. Renamed params, dropped fields, or undocumented required args cause agent call failures.

5. **Use DaemonClient for vault access** — all tools proxy through the daemon HTTP API via `client.get()`, `client.post()`, etc.

6. **Handle errors with ToolFailure interface** — import from `packages/myco/src/tools/error.ts` and wrap operational failures with structured context agents can understand:
   ```typescript
   import { ToolFailure } from './error.js';

   // For parameter validation errors
   throw new ToolFailure('Invalid parameter format', {
     context: { param_name, expected: 'uuid format' },
     retriable: false,
   });

   // For network/service failures
   throw new ToolFailure('Daemon API unavailable', {
     cause: originalError,
     context: { endpoint, attempt: retryCount },
     retriable: true,
   });
   ```

7. **Use canonical ToolFailure interface pattern** — `packages/myco/src/tools/error.ts` exports the standardized `ToolFailure` class with structured error context. Always import and use this interface for agent-facing errors:
   ```typescript
   import { ToolFailure, ToolErrorCode } from './error.js';

   // Standard validation failure
   throw new ToolFailure('Parameter validation failed', {
     code: ToolErrorCode.INVALID_INPUT,
     context: { param: value, constraint: 'must be uuid' },
     retriable: false,
   });

   // Service availability failure
   throw new ToolFailure('Daemon service unavailable', {
     code: ToolErrorCode.SERVICE_UNAVAILABLE,
     cause: networkError,
     context: { endpoint, timeout_ms: 5000 },
     retriable: true,
   });
   ```

## Procedure C: Multi-Transport Registration

Register the tool once in the shared tool runtime. Stdio MCP, HTTP MCP, and the CLI all call through `packages/myco/src/tools/index.ts`; do not add transport-specific switch cases for normal tools.

1. **Shared runtime registration** in `packages/myco/src/tools/index.ts`:
   ```typescript
   [TOOL_MY_NEW_TOOL, async () => {
     const { handleMyNewTool } = await import('./my-new-tool.js');
     return {
       handle: (input, client) => handleMyNewTool(input as MyNewToolInput, client),
       summarize: (input, result) => ({ param_name: input.param_name }),
     };
   }],
   ```

2. **MCP stdio and HTTP registration** — `packages/myco/src/mcp/server.ts` exposes the shared definitions from `packages/myco/src/tools/definitions.ts` and dispatches calls through `createMycoTools(...)`.

3. **CLI registration** — `myco tool list` and `myco tool call` use the same shared runtime, so the tool becomes available there after it is in `TOOL_DEFINITIONS` and `HANDLERS`.

4. **Test multi-transport availability** — verify tool appears in MCP client tool list, HTTP MCP endpoints, and CLI help for all configured transports.

5. **Configure conditional enablement** — Collective tools are automatically enabled/disabled based on `collectiveEnabled` flag across all transports. Local tools are always available.

## Procedure D: Documentation Bundling and Regeneration

Each tool carries inline SKILL.md documentation bundled at compile time across all transports:

1. **Write clear tool documentation** covering:
   - When to use this tool vs alternatives
   - Parameter meanings and examples
   - Expected response format
   - Common usage patterns
   - Transport-specific considerations (MCP stdio vs HTTP vs CLI)

2. **Bundle at build time** — documentation is compiled into handlers during build process and shared across transports.

3. **Regenerate after schema changes**:
   ```bash
   npm run build  # Rebuild bundled documentation for all transports
   ```

4. **Verify agent-visible docs** — test that agents receive current parameter names and descriptions across all transport types, not stale snapshots.

5. **Never ship handler changes without doc updates** — mismatched documentation causes agents to call tools with wrong parameters across any transport.

## Procedure E: Anti-Drift Testing Patterns

Implement systematic checks to catch schema-handler-documentation drift across the shared tool-runtime:

1. **Create test file template** (example: `packages/myco/src/tools/definitions.test.ts`):
   ```typescript
   import { describe, test, expect } from 'vitest';
   import { TOOL_DEFINITIONS, COLLECTIVE_TOOL_DEFINITIONS } from './definitions.js';
   import * as handlers from './index.js';
   ```

2. **Schema-handler parameter alignment test**:
   ```typescript
   test('all schema parameters referenced in handler source', () => {
     const allTools = [...TOOL_DEFINITIONS, ...COLLECTIVE_TOOL_DEFINITIONS];

     for (const tool of allTools) {
       const handlerName = getHandlerNameForTool(tool.name);
       const handler = handlers[handlerName];
       if (!handler) continue; // Skip stubs

       const schemaParams = Object.keys(tool.inputSchema.properties || {});
       const handlerSource = handler.toString();

       schemaParams.forEach(param => {
         expect(handlerSource).toContain(param);
       });
     }
   });
   ```

3. **Handler-schema synchronization test**:
   ```typescript
   test('no orphaned handler parameters', () => {
     // Parse handler destructuring patterns, compare to schema
     // Fail if handler expects parameters not in schema
   });
   ```

4. **Tool name constant consistency**:
   ```typescript
   test('all tool names match exported constants', () => {
     const allTools = [...TOOL_DEFINITIONS, ...COLLECTIVE_TOOL_DEFINITIONS];

     allTools.forEach(tool => {
       expect(tool.name).toMatch(/^(myco_|collective_)/);
       // Verify constant exists and matches
     });
   });
   ```

5. **Multi-transport registration consistency**:
   ```typescript
   test('all tools registered across transports', () => {
     // Verify MCP stdio, HTTP MCP, and CLI registrations are consistent
     // Check that transport-specific configurations align with shared definitions
   });
   ```

6. **Run after every handler or schema change** — drift failures are silent until agents encounter them in production across any transport.

## Procedure F: Stub vs Documented Tool Discipline

Handle incomplete or placeholder tools appropriately:

1. **Mark stubs explicitly** in schema description:
   ```typescript
   {
     name: TOOL_MY_STUB,
     description: '[STUB] This tool is registered but not yet implemented. Returns placeholder response only.',
     // ... rest of definition
   }
   ```

2. **Implement stub handlers** that return consistent "not implemented" responses:
   ```typescript
   export async function handleMyStub(): Promise<{ status: string }> {
     return { status: 'not_implemented' };
   }
   ```

3. **Never document stubs as working tools** — agents should know when functionality is incomplete across all transports.

4. **Test stub behavior** — ensure stubs return consistent responses rather than errors across MCP stdio, HTTP MCP, and CLI.

5. **Remove or implement** — stubs confuse agents across all transports. Either complete the implementation or remove from schema entirely.

## Procedure G: Cloud vs Local Placement Decisions

Decide whether new tools belong in local or cloud MCP surface:

1. **Default to local-only** — new tools go in `TOOL_DEFINITIONS` unless they meet cloud criteria.

2. **Promote to cloud surface** only if tool is:
   - Semantically read-only (no vault writes)
   - Safe for federation (no sensitive data exposure)
   - Required for cross-project Collective operations

3. **Use `COLLECTIVE_TOOL_DEFINITIONS`** for tools that require Collective connection state.

4. **Test both surfaces** — verify tools work correctly in local MCP and (if applicable) cloud federation.

5. **Document placement rationale** — explain why tool belongs in its chosen surface.

## Procedure H: Skill Lifecycle Tool Registration Patterns

The skill lifecycle system requires specific tools that follow domain-specific registration patterns:

1. **Register skill candidate management tools**:
   ```typescript
   // In packages/myco/src/tools/definitions.ts
   export const TOOL_SKILL_CANDIDATES = 'myco_skill_candidates';

   {
     name: TOOL_SKILL_CANDIDATES,
     description: 'Manage skill candidates (identified topics that may become skills). Supports list, get, create, and update actions.',
     cortex: {
       guidance: 'Use for candidate discovery, approval workflows, and candidate lifecycle management',
       priority: 80,
       requiresTeam: false,
       requiresCollective: false,
     },
     annotations: {
       readOnlyHint: false,
       destructiveHint: false,
       idempotentHint: false,
       openWorldHint: false,
     },
     inputSchema: {
       type: 'object',
       properties: {
         action: {
           type: 'string',
           description: 'Action to perform: list, get, create, update, delete'
         },
         id: {
           type: 'string',
           description: 'Candidate ID (required for get/update)'
         },
         topic: {
           type: 'string',
           description: 'Skill topic (required for create)'
         },
         rationale: {
           type: 'string',
           description: 'Why this should be a skill (required for create)'
         },
         status: {
           type: 'string',
           description: 'Candidate status: identified, dismissed'
         }
       },
       required: ['action']
     }
   }
   ```

2. **Register skill record management tools**:
   ```typescript
   export const TOOL_SKILL_RECORDS = 'myco_skill_records';

   {
     name: TOOL_SKILL_RECORDS,
     description: 'Read, update, and delete skill records (materialized skills on disk). Supports list, get, update, and delete actions.',
     cortex: {
       guidance: 'Use for skill lifecycle operations — reading existing skills, updating status, managing skill evolution',
       priority: 80,
     },
     inputSchema: {
       type: 'object',
       properties: {
         action: { type: 'string', description: 'Action: list, get, update, delete' },
         id: { type: 'string', description: 'Skill record ID or name (for get/update/delete)' },
         status: { type: 'string', description: 'Filter by or new status: active, stale, retired' },
         generation: { type: 'number', description: 'New generation number (for update)' }
       },
       required: ['action']
     }
   }
   ```

3. **Register skill file writing tools**:
   ```typescript
   export const TOOL_WRITE_SKILL = 'myco_write_skill';

   {
     name: TOOL_WRITE_SKILL,
     description: 'Write a SKILL.md file to disk and create or update the corresponding skill record and lineage entry.',
     cortex: {
       guidance: 'Use when materializing a new skill from approved candidates or updating existing skills',
       priority: 90,
     },
     annotations: {
       readOnlyHint: false,
       destructiveHint: false,
       idempotentHint: false,
       openWorldHint: false,
     },
     inputSchema: {
       type: 'object',
       properties: {
         name: { type: 'string', description: 'Skill directory name (kebab-case, NO colon)' },
         display_name: { type: 'string', description: 'Human-readable display name' },
         description: { type: 'string', description: 'Short description of what the skill does' },
         content: { type: 'string', description: 'Full SKILL.md content in markdown' },
         rationale: { type: 'string', description: 'Why this skill was created or updated' },
         candidate_id: { type: 'string', description: 'Candidate ID that prompted this skill creation' }
       },
       required: ['name', 'display_name', 'description', 'content']
     }
   }
   ```

4. **Implement domain-specific validation patterns** — skill tools require structural validation (YAML frontmatter, name prefixes, content length limits) that differs from general vault tools.

5. **Test skill workflow integration** — verify tools support the complete skill lifecycle: survey → approve → generate → evolve.

## Procedure I: Shared Tool-Runtime Integration

Integrate with the shared tool-runtime supporting multiple transports:

1. **Configure transport-specific behaviors**:
   ```typescript
   // Different transports may need different error handling
   const formatResponse = (result: any, transport: 'mcp' | 'http' | 'cli') => {
     switch (transport) {
       case 'mcp': return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
       case 'http': return result; // Direct JSON response
       case 'cli': return formatCliOutput(result); // Human-readable format
     }
   };
   ```

2. **Handle transport-specific authentication** — MCP stdio uses connection-level auth, HTTP MCP uses token auth, CLI uses file-based auth.

3. **Implement transport-aware logging**:
   ```typescript
   logActivity(TOOL_NAME, {
     ...params,
     transport: 'mcp|http|cli',
     duration_ms: Date.now() - start
   });
   ```

4. **Test cross-transport consistency** — verify same input produces equivalent results across MCP stdio, HTTP MCP, and CLI transports.

5. **Document transport differences** — note any transport-specific behaviors or limitations in tool documentation.

## Procedure J: Grove Migration Context Handling

Handle project context changes with Grove migration architecture:

1. **Update context injection patterns** for Grove migration compatibility:
   ```typescript
   // Old: Direct project context injection
   const context = await injectProjectContext(sessionId);

   // New: Grove-aware context injection with fallback
   const context = await injectGroveContext(sessionId, {
     fallbackToLocal: true,
     respectGroveConfig: true,
   });
   ```

2. **Handle Grove project boundaries** when tools access cross-project resources:
   ```typescript
   export async function handleCrossProjectTool(
     input: CrossProjectInput,
     client: DaemonClient,
   ): Promise<CrossProjectResult> {
     // Validate Grove project permissions before access
     const groveAccess = await client.get('/api/grove/validate-access', {
       targetProject: input.project_id,
       operation: 'read',
     });

     if (!groveAccess.allowed) {
       throw new ToolFailure('Grove access denied', {
         context: { project_id: input.project_id, reason: groveAccess.reason },
         retriable: false,
       });
     }

     // Proceed with Grove-scoped operation
     return await performGroveOperation(input, client);
   }
   ```

3. **Configure Grove-aware tool definitions** with proper scope annotations:
   ```typescript
   {
     name: TOOL_GROVE_AWARE,
     description: 'Tool that operates across Grove project boundaries',
     cortex: {
       guidance: 'Use for cross-project operations in Grove environments',
       requiresGrove: true, // New Grove requirement flag
     },
     annotations: {
       crossProjectHint: true, // Indicates Grove boundary crossing
     },
   }
   ```

4. **Test Grove project isolation** — verify tools respect Grove project boundaries and fail gracefully when Grove is not configured.

5. **Document Grove migration impact** — note how tools behave differently in Grove vs traditional project structures.

## Cross-Cutting Gotchas

**Silent parameter drops**: When schema defines a parameter but handler ignores it, agents receive no error — their input is silently dropped. This is the most common drift failure.

**Documentation lag**: Bundled SKILL.md becomes stale when handlers change. Always regenerate documentation after schema or handler modifications.

**Cloud surface leakage**: Write operations must never leak to cloud MCP surface. Default to local-only; promote to cloud only with explicit read-only verification.

**Validation vs runtime divergence**: Schema validation passes but handler expects different parameter structure. Test actual invocations, not just schema validation.

**Collective conditional enablement**: `collective_*` tools are enabled by Collective connection state. Test both connected and disconnected scenarios across all transports.

**Tool name consistency**: Use `myco_` prefix for standard tools, `collective_` prefix for Collective-dependent tools. Avoid generic names that conflict with other MCP servers.

**Handler signature mismatch**: All handlers must accept `(input, client)` parameters. Missing DaemonClient parameter causes registration failures.

**Cross-runtime schema compatibility**: OpenAI strict mode and Zod refinement patterns cause silent registration failures. Use plain JSON Schema types with descriptive documentation instead of complex validation constructs.

**Skill tool registration gaps**: Skill lifecycle operations require complete tool registration (candidates, records, write_skill) — missing any component breaks agent workflows. Always register skill tools as a complete set.

**Shared tool-runtime path shifts**: Tool definitions live in `packages/myco/src/tools/definitions.ts`. Update import paths and test references when the shared runtime moves.

**Multi-transport registration complexity**: Shared tool-runtime requires consistent registration across MCP stdio, HTTP MCP, and CLI transports. Test all transports when adding new tools.

**Transport-specific error handling**: Different transports expect different response formats. Implement transport-aware error formatting to prevent agent confusion.

**ToolFailure anti-pattern**: Never throw raw Error objects from handlers — always wrap with ToolFailure interface for consistent agent error handling. Missing structured error context causes agent confusion across all transports.

**Code duplication across tool surface**: Avoid copy-pasting handler patterns between tools. Extract shared utilities to `packages/myco/src/tools/shared.ts` and import consistently. Duplicated validation logic, error handling, and response formatting patterns create maintenance burden and drift risks across the unified tool surface. Use composition patterns instead:
```typescript
// BAD: Duplicated validation across multiple tools
function handleToolA(input) {
  if (!input.session_id || !isValidUuid(input.session_id)) {
    throw new ToolFailure('Invalid session_id');
  }
  // ... tool logic
}

function handleToolB(input) {
  if (!input.session_id || !isValidUuid(input.session_id)) {
    throw new ToolFailure('Invalid session_id');
  }
  // ... tool logic (nearly identical validation)
}

// GOOD: Shared validation utilities
import { validateSessionId, validateRequiredString } from './shared.js';

function handleToolA(input) {
  validateSessionId(input.session_id);
  // ... tool logic
}

function handleToolB(input) {
  validateSessionId(input.session_id);
  // ... tool logic
}
```

**Grove context injection failures**: Tools accessing project context must handle Grove migration gracefully. Missing Grove-aware context injection causes failures in Grove environments while working in traditional project structures, creating environment-specific bugs.