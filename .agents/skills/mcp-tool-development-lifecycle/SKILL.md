---
name: myco:mcp-tool-development-lifecycle
description: |
  Comprehensive lifecycle for authoring, registering, documenting, and maintaining MCP tools in packages/myco/src/mcp/ — covering schema definition in TOOL_DEFINITIONS arrays, handler implementation with DaemonClient patterns, switch-based registration in server.ts, documentation bundling, anti-drift testing patterns, and cloud vs local placement decisions. Essential for maintaining the schema ↔ handler ↔ documentation triad that agents depend on for correct tool invocations, even when the user doesn't explicitly ask for MCP tool development.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# MCP Tool Development and Anti-Drift Maintenance

MCP tools are the primary interface between agents and the Myco intelligence pipeline. Each tool requires a coordinated schema ↔ handler ↔ documentation triad that can drift over time, causing silent agent failures. This skill covers the complete development lifecycle and maintenance procedures to prevent drift regressions.

## Prerequisites

- Working Myco development environment with `packages/myco/src/mcp/` structure
- Understanding of JSON Schema for parameter definitions
- Familiarity with TypeScript handler patterns and DaemonClient usage
- Knowledge of local vs cloud MCP bifurcation model

## Procedure A: Schema Definition

Define the tool interface in `packages/myco/src/mcp/tool-definitions.ts`:

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

## Procedure B: Handler Implementation

Create the handler in `packages/myco/src/mcp/tools/my-new-tool.ts`:

1. **Import required types and client**:
   ```typescript
   import type { DaemonClient } from '@myco/hooks/client.js';
   import { buildEndpoint } from './shared.js';
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

3. **Implement the handler function**:
   ```typescript
   export async function handleMyNewTool(
     input: MyNewToolInput,
     client: DaemonClient,
   ): Promise<MyNewToolResult> {
     // Validate all schema-declared parameters are consumed
     const { param_name, optional_param = defaultValue } = input;
     
     const endpoint = buildEndpoint('/api/some-operation', {
       param_name,
       optional_param,
     });
     
     const response = await client.get(endpoint);
     return response as MyNewToolResult;
   }
   ```

4. **Consume every schema parameter** — handlers must accept exactly what the schema advertises. Renamed params, dropped fields, or undocumented required args cause agent call failures.

5. **Use DaemonClient for vault access** — all tools proxy through the daemon HTTP API via `client.get()`, `client.post()`, etc.

6. **Handle errors gracefully** — let DaemonClient errors bubble up; they're already structured for agent consumption.

## Procedure C: Tool Registration and Conditional Enablement

Register the tool in `packages/myco/src/mcp/server.ts`:

1. **Import the handler**:
   ```typescript
   import { handleMyNewTool } from './tools/my-new-tool.js';
   ```

2. **Import the tool constant**:
   ```typescript
   import { TOOL_MY_NEW_TOOL } from './tool-definitions.js';
   ```

3. **Add switch case** in the `callTool` handler function:
   ```typescript
   case TOOL_MY_NEW_TOOL: {
     const myInput = request.params.arguments as MyNewToolInput;
     const result = await handleMyNewTool(myInput, daemonClient);
     logActivity(TOOL_MY_NEW_TOOL, { param_name: myInput.param_name, duration_ms: Date.now() - start });
     return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
   }
   ```

4. **Test local registration** — verify tool appears in MCP client tool list and accepts test invocations.

5. **Configure conditional enablement** — Collective tools are automatically enabled/disabled based on `collectiveEnabled` flag. Local tools are always available.

## Procedure D: Documentation Bundling and Regeneration

Each MCP tool carries inline SKILL.md documentation bundled at compile time:

1. **Write clear tool documentation** covering:
   - When to use this tool vs alternatives
   - Parameter meanings and examples
   - Expected response format
   - Common usage patterns

2. **Bundle at build time** — documentation is compiled into the handler during the build process.

3. **Regenerate after schema changes**:
   ```bash
   npm run build  # Rebuild bundled documentation
   ```

4. **Verify agent-visible docs** — test that agents receive current parameter names and descriptions, not stale snapshots.

5. **Never ship handler changes without doc updates** — mismatched documentation causes agents to call tools with wrong parameters.

## Procedure E: Anti-Drift Testing Patterns

Implement systematic checks to catch schema-handler-documentation drift:

1. **Create test file** `packages/myco/src/mcp/tool-definitions.test.ts` if it doesn't exist:
   ```typescript
   import { describe, test, expect } from 'vitest';
   import { TOOL_DEFINITIONS, COLLECTIVE_TOOL_DEFINITIONS } from './tool-definitions.js';
   import * as handlers from './tools/index.js'; // Export all handlers from index
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

5. **Run after every handler or schema change** — drift failures are silent until agents encounter them in production.

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

3. **Never document stubs as working tools** — agents should know when functionality is incomplete.

4. **Test stub behavior** — ensure stubs return consistent responses rather than errors.

5. **Remove or implement** — stubs confuse agents. Either complete the implementation or remove from schema entirely.

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

## Cross-Cutting Gotchas

**Silent parameter drops**: When schema defines a parameter but handler ignores it, agents receive no error — their input is silently dropped. This is the most common drift failure.

**Documentation lag**: Bundled SKILL.md becomes stale when handlers change. Always regenerate documentation after schema or handler modifications.

**Cloud surface leakage**: Write operations must never leak to cloud MCP surface. Default to local-only; promote to cloud only with explicit read-only verification.

**Validation vs runtime divergence**: Schema validation passes but handler expects different parameter structure. Test actual invocations, not just schema validation.

**Collective conditional enablement**: `collective_*` tools are enabled by Collective connection state. Test both connected and disconnected scenarios.

**Tool name consistency**: Use `myco_` prefix for standard tools, `collective_` prefix for Collective-dependent tools. Avoid generic names that conflict with other MCP servers.

**Handler signature mismatch**: All handlers must accept `(input, client)` parameters. Missing DaemonClient parameter causes registration failures.