---
name: myco:mcp-tool-development-lifecycle
description: "Comprehensive lifecycle for authoring, registering, documenting, and maintaining MCP tools in packages/myco/src/tools/ — covering schema definition in TOOL_DEFINITIONS arrays, handler implementation with DaemonClient patterns, shared tool-runtime registration, documentation bundling, anti-drift testing patterns, and per-symbiont transport (mcp vs cli) decisions. Essential for maintaining the schema ↔ handler ↔ documentation triad that agents depend on for correct tool invocations, even when the user doesn't explicitly ask for MCP tool development."
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
- Understanding of shared tool-runtime supporting multiple transports (MCP stdio, HTTP MCP, CLI)

## Procedure A: Schema Definition

Define the tool interface in `packages/myco/src/tools/definitions.ts` (shared tool-runtime definitions):

1. **Add tool name constant** at the top of the file:
   ```typescript
   export const TOOL_MY_NEW_TOOL = 'myco_my_new_tool';
   ```

2. **Add schema entry** to `TOOL_DEFINITIONS` (the single local tool-definition array — there is no separate cloud/Collective array; the daemon's Collective MCP integration was removed):
   ```typescript
   {
     name: TOOL_MY_NEW_TOOL,
     description: 'Brief description of what this tool does — agents use this for selection decisions',
     cortex: {
       guidance: 'Clear guidance for when to use this tool vs alternatives',
       priority: 50,
     },
     annotations: {
       readOnlyHint: true,
       destructiveHint: false,
       idempotentHint: true,
       openWorldHint: false,
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

6. **Configure cortex metadata** — set `priority` and `guidance` to help agent tool-selection; there is no Collective-connection gate to configure (that conditional-enablement mechanism was removed with the daemon's Collective integration).

7. **Avoid OpenAI strict mode incompatibilities** — OpenAI's strict JSON Schema mode rejects `oneOf`, `anyOf`, `allOf`, `enum`, and `not` keywords at the top level. Use simple types with clear descriptions instead.

8. **Avoid Zod refinement-like patterns** — Schema constructs that imply Zod refinements cause silent tool registration failures. Never use `.default()`, `.min()`, `.max()`, or `.refine()` patterns in schema definitions.

## Procedure B: Handler Implementation

Create the handler in `packages/myco/src/tools/my-new-tool.ts`:

1. **Import required types and client**:
   ```typescript
   import type { DaemonClient } from '@myco/hooks/client.js';
   import { buildEndpoint } from './shared.js';
   import { ToolFailure } from './error.js';
   ```

2. **Define input and result types** with clear interfaces.

3. **Implement the handler function with canonical error handling** — consume all schema parameters, use DaemonClient for vault access.

4. **Handle errors with ToolFailure interface** — import from `packages/myco/src/tools/error.ts` and wrap operational failures with structured context agents can understand.

5. **Use canonical ToolFailure interface pattern** — always import and use this interface for agent-facing errors with structured error context.

## Procedure C: Multi-Transport Registration

Register the tool once in the shared tool runtime. Stdio MCP, HTTP MCP, and the CLI all call through `packages/myco/src/tools/index.ts`; do not add transport-specific switch cases for normal tools.

1. **Shared runtime registration** in `packages/myco/src/tools/index.ts`
2. **MCP stdio and HTTP registration** — automatically handled via shared definitions
3. **CLI registration** — becomes available after tool is in TOOL_DEFINITIONS
4. **Test multi-transport availability** — verify tool appears in MCP client, HTTP MCP endpoints, and CLI

## Procedure D: Documentation Bundling and Regeneration

Each tool carries inline SKILL.md documentation bundled at compile time across all transports:

1. **Write clear tool documentation** covering when to use, parameters, response format, and usage patterns.
2. **Bundle at build time** — documentation is compiled into handlers and shared across transports.
3. **Regenerate after schema changes** via `npm run build`.
4. **Verify agent-visible docs** — test that agents receive current parameter names across all transport types.
5. **Never ship handler changes without doc updates** — mismatched documentation causes agent call failures.

## Procedure E: Anti-Drift Testing Patterns

Implement systematic checks to catch schema-handler-documentation drift across the shared tool-runtime:

1. **Create test file** (`tests/tools/definitions.test.ts`) with schema-handler parameter alignment tests. Test files live under `tests/` — the runner discovers nothing outside it, and `tests/meta/test-suite-integrity.test.ts` fails CI on a test authored anywhere else.

2. **Schema-handler parameter alignment test** — verify all schema parameters are referenced in handler source.

3. **Handler-schema synchronization test** — fail if handler expects parameters not in schema.

4. **Tool name constant consistency** — verify all tool names match exported constants and follow proper prefixing.

5. **Tool name canonicalization validation**:
   ```typescript
   test('tool names follow canonical prefixes across all transports', () => {
     const allTools = [...TOOL_DEFINITIONS, ...COLLECTIVE_TOOL_DEFINITIONS];
     
     allTools.forEach(tool => {
       // Fail on legacy double-prefix or bare names from pre-unification
       expect(tool.name).not.toMatch(/^myco_myco_/);
       
       // Verify activities table records use same canonicalized name
       const activitiesRecord = getActivityRecord(tool.name);
       expect(activitiesRecord.tool_name).toBe(tool.name);
     });
   });
   ```

6. **Multi-transport registration consistency** — verify MCP stdio, HTTP MCP, and CLI registrations are consistent.

7. **Run after every handler or schema change** — drift failures are silent until agents encounter them in production.

## Procedure F: Stub vs Documented Tool Discipline

Handle incomplete or placeholder tools appropriately:

1. **Mark stubs explicitly** in schema description as `[STUB]`.
2. **Implement stub handlers** that return consistent "not implemented" responses.
3. **Never document stubs as working tools** — agents should know when functionality is incomplete.
4. **Test stub behavior** — ensure stubs return consistent responses across all transports.
5. **Remove or implement** — stubs confuse agents. Either complete or remove entirely.

## Procedure G: Per-Symbiont Transport Decisions

There is a single local tool surface (`TOOL_DEFINITIONS`) — the daemon's Collective MCP
integration (a separate `COLLECTIVE_TOOL_DEFINITIONS` array, `collective_*` tools, and their
conditional connection-state enablement) was removed when Collective integration was retired
from the main binary. `packages/myco-collective` itself still exists as a standalone,
dormant-but-buildable package with its own tools — but it is no longer wired into the
daemon's MCP surface, so new daemon tools always go in `TOOL_DEFINITIONS`.

What still varies per-symbiont is **transport**, not placement:

1. **All new tools go in `TOOL_DEFINITIONS`** — there is no separate surface to choose between.
2. **Check the target symbiont's `toolTransport`** — a `cli`-transport symbiont receives no MCP tools at all regardless of definition; it calls tools via `myco tool call` instead (see below).
3. **Test across transports actually in use** — MCP stdio, HTTP MCP (Team Host's external read-only endpoint), and CLI — not across a local/cloud split that no longer exists.
4. **Document any transport-specific behavior**, not a placement rationale.

**`toolTransport` manifest field drives symbiont installer seams**: Each symbiont manifest declares `toolTransport: 'mcp' | 'cli'` (defined in `packages/myco/src/symbionts/manifest-schema.ts`, defaulting to `'mcp'`). This single field controls three installer seams:
   - `shouldProvisionMcpServer()` in `packages/myco/src/symbionts/installer.ts` — returns `false` for `cli` transport, skipping MCP server provisioning entirely
   - `cliToolTransportDirective` injection (from `packages/myco/src/context/cortex-injection-context.ts`) — injected into context when `toolTransport === 'cli'` so the agent knows to call tools via `myco tool call` instead of MCP
   - `myco doctor` treatment — CLI-transport symbionts have MCP config swept/uninstalled rather than verified

   Always check the target symbiont's `toolTransport` when adding a new tool — a `cli` symbiont cannot receive MCP tools regardless of TOOL_DEFINITIONS placement.

## Procedure H: Skill Lifecycle Belongs Inside the Harness, Not on MCP

Skill candidates, skill records, and skill file writes are managed by the **Myco agent** — not exposed as MCP tools for Symbionts. If you need a new affordance for the skill lifecycle, add it under `packages/myco/src/agent/tools/`, not `packages/myco/src/tools/`.

## Procedure I: Shared Tool-Runtime Integration

Integrate with the shared tool-runtime supporting multiple transports:

1. **Configure transport-specific behaviors** — different transports may need different error handling and response formatting.
2. **Handle transport-specific authentication** — MCP stdio uses connection-level auth, HTTP MCP uses token auth, CLI uses file-based auth.
3. **Implement transport-aware logging** — record transport type in activity logs.
4. **Test cross-transport consistency** — verify same input produces equivalent results across all transports.
5. **Document transport differences** — note any transport-specific behaviors or limitations.

## Procedure J: Grove Migration Context Handling

Handle project context changes with Grove migration architecture:

1. **Update context injection patterns** for Grove migration compatibility with fallback options.
2. **Handle Grove project boundaries** when tools access cross-project resources.
3. **Configure Grove-aware tool definitions** with proper scope annotations.
4. **Test Grove project isolation** — verify tools respect Grove boundaries and fail gracefully.
5. **Document Grove migration impact** — note how tools behave differently in Grove vs traditional structures.

## Cross-Cutting Gotchas

**Silent parameter drops**: When schema defines a parameter but handler ignores it, agents receive no error — input is silently dropped. Most common drift failure.

**Documentation lag**: Bundled documentation becomes stale when handlers change. Always regenerate after schema or handler modifications.

**Validation vs runtime divergence**: Schema validation passes but handler expects different parameter structure. Test actual invocations.

**Tool name consistency**: Use the `myco_` prefix for all tools. Avoid generic names that conflict with other MCP servers.

**Tool name canonicalization**: The activities table records tool calls with canonicalized names. Never use legacy prefixes from pre-unification period. Current standard: `mcp__` for MCP-specific tools, `myco_` for standard tools. Verify activities records match tool definitions exactly.

**Handler signature mismatch**: All handlers must accept `(input, client)` parameters. Missing DaemonClient parameter causes registration failures.

**Cross-runtime schema compatibility**: OpenAI strict mode and Zod refinement patterns cause silent registration failures. Use plain JSON Schema with descriptive documentation.

**Skill tool registration gaps**: Skill lifecycle operations require complete tool registration — missing components break agent workflows.

**Multi-transport registration complexity**: Shared tool-runtime requires consistent registration across MCP stdio, HTTP MCP, and CLI. Test all transports when adding tools.

**Transport-specific error handling**: Different transports expect different response formats. Implement transport-aware error formatting.

**ToolFailure anti-pattern**: Never throw raw Error objects — always wrap with ToolFailure for consistent agent handling.

**Code duplication**: Extract shared utilities to `packages/myco/src/tools/shared.ts`. Avoid copy-pasting handler patterns.

**Grove context injection failures**: Tools accessing project context must handle Grove migration gracefully to avoid environment-specific bugs.

**Copilot CLI deferred-tool model**: The copilot CLI uses a deferred/searchable-tool model — one-shot tool probes ("do you have myco tools?") return a false-negative `NO_MYCO_MCP` or `NONE` even when the stdio bridge is connected and tools are available. The fix is to explicitly trigger tool search using the tool search regex pattern rather than relying on a single passive probe. Never treat a one-shot copilot tool absence as evidence that MCP is misconfigured; always verify with an explicit tool search invocation.
