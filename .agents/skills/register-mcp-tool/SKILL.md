---
name: myco:register-mcp-tool
description: |
  Use this skill when adding a new MCP tool to the Myco vault daemon's MCP server — whether to expose a new query, a write operation, a search endpoint, or any callable action that agents need. Activates whenever you create a tool file under src/mcp/tools/, modify src/mcp/server.ts, or add a new capability to the vault's MCP surface. Apply this skill even if the user doesn't explicitly say "MCP tool" — if they ask to "add a way for agents to call X" or "expose Y to the agent," this is the right pattern. Covers tool file anatomy, Zod input schema, MCP content response format, and the two-step registration in server.ts.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Register a New MCP Tool in the Myco Vault Daemon

The Myco daemon exposes vault capabilities to agents through an MCP server (`src/mcp/server.ts`). Every callable action — reads, writes, searches, state updates — is a registered MCP tool. Adding a new tool is a two-step process: write the tool handler file, then register it in the server.

## Prerequisites

- You know what the tool should do and what inputs it requires.
- If the tool needs a new DB table, follow the `add-vault-table` skill first — come back here once the query module exists.
- The daemon is running locally (`myco start`) so you can test after wiring.

## Steps

### 1. Create the tool file

Each tool lives in its own file under `src/mcp/tools/`. Name the file after what the tool does, kebab-case:

```
src/mcp/tools/your-tool-name.ts
```

The standard anatomy for a tool file:

```typescript
import { z } from "zod";
import type { McpToolDefinition } from "../types.js";
// Import the relevant db query function(s)
import { yourDbFunction } from "../../db/your-module.js";

// 1. Define the input schema with Zod
const InputSchema = z.object({
  required_param: z.string(),
  optional_param: z.number().optional(),
  // Use .describe() on fields so agents understand them
  limit: z.number().optional().describe("Max results to return (default 20)"),
});

// 2. Export the tool definition
export const yourToolName: McpToolDefinition = {
  name: "vault_your_tool_name",   // snake_case, prefixed with vault_
  description:
    "One sentence: what the tool does, when to use it, what it returns.",
  inputSchema: InputSchema,

  async handler(args: unknown) {
    const input = InputSchema.parse(args);  // throws on bad input — intentional

    const results = await yourDbFunction(input.required_param, {
      limit: input.limit ?? 20,
    });

    // 3. Return MCP content array
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  },
};
```

**Why `vault_` prefix?** All vault tools share this namespace so agents can immediately recognize them in tool lists. Keep the snake_case convention — MCP tool names must not contain hyphens.

### 2. Register in server.ts

Open `src/mcp/server.ts`. There are two places to touch:

**a) Import the tool:**

```typescript
// Near the top, grouped with other tool imports
import { yourToolName } from "./tools/your-tool-name.js";
```

**b) Add to the tools array:**

Find the array where all tools are listed (look for the other `vault_*` tool names) and append yours:

```typescript
const tools: McpToolDefinition[] = [
  vaultState,
  vaultUnprocessed,
  // ... existing tools ...
  yourToolName,   // ← add here
];
```

The server iterates this array to register each tool with the MCP SDK and to dispatch `callTool` requests — one registration covers both.

### 3. Restart and verify

```bash
# Restart the daemon to pick up the new tool
myco restart

# Or during development, check the MCP tool list via the daemon UI
# Settings → MCP → tool count should increment
```

After restarting, the tool is immediately available to any connected agent (Claude Code, etc.).

## Writing Good Tool Descriptions

The `description` field is how agents decide whether to call your tool. Be explicit about:
- **When to use it** — the scenario, not just the action
- **What it returns** — "returns a JSON array of spore objects" beats "returns data"
- **Key parameters** — mention notable optional params inline

Example of a weak description: `"Gets sessions from the vault."`

Example of a strong description: `"List vault sessions ordered by most recent. Use when you need to find a session by status or verify a session exists. Returns session metadata including id, title, summary, and status."`

## Common Pitfalls

**Forgetting `.js` in import paths.** TypeScript source uses `.ts` but the compiled output (and Node's ESM resolver) needs `.js`. Always write:
```typescript
import { yourDbFunction } from "../../db/your-module.js";  // ✓
import { yourDbFunction } from "../../db/your-module";     // ✗ breaks at runtime
```

**Returning raw strings instead of the content array.** MCP requires the `{ content: [{ type: "text", text: "..." }] }` envelope. Returning a plain object or string will cause a protocol error.

**Mutating state without validation.** For write tools, always parse with Zod before touching the DB. The `InputSchema.parse(args)` call throws a structured error that the MCP SDK surfaces cleanly to the agent — better than an opaque crash.

**Tool name collisions.** Before choosing a name, grep for it:
```bash
grep -r "vault_your_tool_name" src/mcp/
```
Duplicate names silently shadow the first registration; the server won't warn you.

**Long-running operations without timeouts.** If your tool calls external APIs or does heavy DB work, add a timeout or document the expected latency in the description so agents can set appropriate expectations.

## Pattern: Tools That Return Paginated Results

For tools that can return many rows, mirror the cursor pattern used by `vault_unprocessed`:

```typescript
const InputSchema = z.object({
  after_id: z.number().optional().describe("Cursor for pagination"),
  limit: z.number().optional().default(50),
});

// In the handler, pass cursor to the db layer
const rows = await queryYourTable({ afterId: input.after_id, limit: input.limit });
return {
  content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
};
```

Agents can then page through results by passing the last returned ID as `after_id` on the next call.
