---
name: myco:canopy-manifest-driven-tool-resolution
description: |
  Implement manifest-driven tool resolution for Canopy read-tool detection across symbionts. Covers adding canopyReadTools discriminated union declarations to symbiont manifests (structured vs shell-pattern modes), implementing symbiont-agnostic resolvers, unifying pre/post tool-use hooks, and updating database queries to respect manifest declarations. Use when adding new symbionts that need Canopy integration, extending tool resolution capabilities, or debugging read-tool detection issues, even if the user doesn't explicitly ask for manifest-driven architecture.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Canopy Manifest-Driven Tool Resolution Architecture

Canopy's manifest-driven tool resolution provides a single source of truth for determining which symbiont tools constitute file reads, enabling consistent path extraction across hooks, database queries, and analytics. This architecture eliminates hardcoded per-symbiont assumptions and makes adding new symbionts require only manifest declarations, not code changes.

## Prerequisites

- Understanding of symbiont manifest structure in `packages/myco/src/symbionts/manifests/`
- Familiarity with Canopy's pre/post tool-use hooks in `packages/myco/src/hooks/`
- Knowledge of the activity database schema and drilldown query patterns
- Access to test infrastructure for validating tool resolution changes

## Procedure A: Add canopyReadTools to Symbiont Manifest

Define which tools constitute file reads using the `capabilities.canopyReadTools` discriminated union in the symbiont's YAML manifest.

### For Structured Tools (e.g., Claude Code)

When the symbiont exposes named tools with structured arguments:

```yaml
# packages/myco/src/symbionts/manifests/claude-code.yaml
capabilities:
  canopyReadTools:
    mode: structured
    tool: Read
    filePath: file
```

- **mode: structured** - Tool has named fields for arguments
- **tool** - Exact tool name that triggers Canopy injection  
- **filePath** - Field name containing the file path

### For Shell-Pattern Tools (e.g., Codex)

When the symbiont uses shell commands with regex-based path extraction:

```yaml
# packages/myco/src/symbionts/manifests/codex.yaml
capabilities:
  canopyReadTools:
    mode: shell-args
    patterns:
      - { command: '(sed|rg|perl|nl)', pathArg: last }
      - { command: 'head|tail', pathArg: last }
```

- **mode: shell-args** - Tool uses shell command patterns
- **patterns** - Array of command regex + path extraction strategies
- **command** - Regex matching shell commands that read files
- **pathArg: last** - Extract path from last positional argument (supports shell quote parsing via `shlex`)

**Pattern selection:** Use `structured` for symbionts with formal tool schemas. Use `shell-args` for symbionts that execute shell commands where file paths appear in predictable argument positions.

## Procedure B: Implement Symbiont-Agnostic Resolver

Create or update the resolver that dispatches on manifest declarations to extract file paths uniformly across symbionts.

### Core Resolver Function

```typescript
// packages/myco/src/symbionts/canopy-read-tools.ts
export function resolveCanopyReadTool(
  symbiont: SymbiontManifest,
  toolName: string,
  toolInput: any
): string | null {
  const config = symbiont.capabilities?.canopyReadTools;
  if (!config) return null;

  switch (config.mode) {
    case 'structured':
      if (toolName !== config.tool) return null;
      return toolInput[config.filePath] || null;

    case 'shell-args':
      for (const pattern of config.patterns) {
        if (new RegExp(pattern.command).test(toolName)) {
          return extractPathFromShellArgs(toolInput, pattern.pathArg);
        }
      }
      return null;

    default:
      return null;
  }
}
```

### Shell Argument Parsing

For shell-pattern mode, use `shlex` for quote-aware argument parsing. The function must check both `toolInput.command` and `toolInput.bash?.command` to handle varying symbiont argument structures:

```typescript
import shlex from 'shlex';

function extractPathFromShellArgs(toolInput: any, strategy: string): string | null {
  // Handle both direct command and nested bash.command patterns
  const command = toolInput.command || toolInput.bash?.command;
  if (!command || typeof command !== 'string') return null;

  try {
    const tokens = shlex.split(command);
    if (strategy === 'last' && tokens.length > 1) {
      return tokens[tokens.length - 1];
    }
    // Add other strategies as needed
  } catch (error) {
    return null;
  }

  return null;
}
```

**Design principle:** The resolver is the single authority for path extraction. All consumers (hooks, queries) must use this resolver to maintain consistency. The dual `toolInput.command || toolInput.bash?.command` pattern handles symbionts that structure shell arguments differently.

## Procedure C: Unify Pre/Post Tool-Use Hooks

Ensure both pre-tool-use and post-tool-use hooks use the same manifest-driven resolver for detecting Canopy reads.

### Update Pre-Tool-Use Hook

```typescript
// packages/myco/src/hooks/pre-tool-use.ts
import { resolveCanopyReadTool } from '../symbionts/canopy-read-tools.ts';

export async function preToolUse(input: ToolUseInput): Promise<void> {
  const filePath = resolveCanopyReadTool(input.symbiont, input.toolName, input.toolInput);
  if (!filePath) return;

  // Inject Canopy content for the resolved file path
  await injectCanopyContent(filePath, input);
}
```

### Update Post-Tool-Use Hook

```typescript
// packages/myco/src/hooks/post-tool-use.ts  
import { resolveCanopyReadTool } from '../symbionts/canopy-read-tools.ts';

export async function postToolUse(activity: ActivityRecord): Promise<void> {
  const filePath = resolveCanopyReadTool(activity.symbiont, activity.toolName, activity.toolInput);
  if (!filePath) return;

  // Record canopy_injection_tokens on the activity
  await recordInjectionTokens(activity.id, filePath);
}
```

**Critical gotcha:** Pre/post hook parity is required. If only PreToolUse uses the resolver, injection tokens will be recorded but won't land on activity rows, creating silent stat gaps in the dashboard.

## Procedure D: Update Database Queries for Manifest Compliance

Convert hardcoded drilldown queries to use manifest-driven patterns for identifying Canopy reads.

### Query Pattern Transformation

Before (hardcoded):
```sql
-- Assumes only Claude's Read tool matters
WHERE tool_name = 'Read' AND JSON_EXTRACT(tool_input, '$.file_path') IS NOT NULL
```

After (manifest-driven):
```sql  
-- Uses patterns from all enabled symbiont manifests
WHERE CASE 
  WHEN tool_name IN ('Read') THEN JSON_EXTRACT(tool_input, '$.file')
  WHEN tool_name IN ('bash') THEN /* shell pattern extraction */
  -- More patterns as manifests declare them
END IS NOT NULL
```

### Implementation in Aggregators

```typescript
// packages/myco/src/db/schema.ts
export function buildCanopyReadQuery(symbionts: SymbiontManifest[]): string {
  const patterns: Array<{toolName: string, argPath: string}> = [];
  
  for (const symbiont of symbionts) {
    const config = symbiont.capabilities?.canopyReadTools;
    if (config?.mode === 'structured') {
      patterns.push({
        toolName: config.tool,
        argPath: `$.${config.filePath}`
      });
    }
    // Handle shell-args mode with appropriate SQL regex
  }

  return `
    SELECT * FROM activities 
    WHERE ${patterns.map(p => 
      `(tool_name = '${p.toolName}' AND JSON_EXTRACT(tool_input, '${p.argPath}') IS NOT NULL)`
    ).join(' OR ')}
  `;
}
```

**Scalability:** This pattern scales to future symbionts without schema changes. The manifest is the authoritative declaration; queries dynamically adapt.

## Procedure E: Validate End-to-End Tool Resolution

Test the complete pipeline from manifest declaration through database recording.

### Integration Test Pattern

```typescript
// Test both structured and shell-pattern modes
describe('Canopy tool resolution', () => {
  it('processes Claude structured reads', async () => {
    const input = {
      symbiont: claudeManifest,
      toolName: 'Read', 
      toolInput: { file: 'src/app.ts' }
    };
    
    expect(resolveCanopyReadTool(input.symbiont, input.toolName, input.toolInput))
      .toBe('src/app.ts');
  });

  it('processes Codex shell-pattern reads', async () => {
    const input = {
      symbiont: codexManifest,
      toolName: 'bash',
      toolInput: { command: 'sed -n "1,220p" src/config.json' }
    };
    
    expect(resolveCanopyReadTool(input.symbiont, input.toolName, input.toolInput))
      .toBe('src/config.json');
  });
});
```

### Live Validation

Monitor dashboard stats after deployment:
1. **Activity counts** - Verify both symbionts produce activity rows with `canopy_injection_tokens`
2. **Token counts** - Confirm injection tokens appear in expected ranges (1000+ per active session)
3. **Query consistency** - Ensure drilldown queries return same reads that hooks detected

**Debugging tip:** If PreToolUse fires but PostToolUse doesn't record injection tokens, check that both hooks use the identical resolver call pattern.

## Cross-Cutting Gotchas

### Single Source of Truth Enforcement

**Never duplicate path-extraction logic outside the manifest.** All consumers (hooks, queries, analytics, FTS indexing) must derive read-tool knowledge from `capabilities.canopyReadTools`. Hardcoded assumptions create drift and silent failures.

**Detection pattern:** If you find yourself writing `if (toolName === 'Read')` or `if (command.includes('sed'))` anywhere outside the resolver, you're breaking the abstraction.

### Test Enumeration Drift

**Tests that enumerate symbionts by name go stale.** Any test asserting a hardcoded list of symbiont names (e.g., "bootstrap creates files for Claude, Cursor, Codex, and 3 others") will miss new symbionts without failing.

**Fix:** Derive expected sets from `loadManifests()` instead of magic strings:

```typescript
// Fragile - goes stale
expect(createdFiles).toContain('.claude/settings.json');
expect(createdFiles).toContain('.cursor/hooks.json');

// Robust - adapts to manifest changes  
const manifests = await loadManifests();
for (const manifest of manifests) {
  expect(createdFiles).toContain(manifest.expectedBootstrapFile);
}
```

### Nested Shell Command Arguments

**Shell-pattern extraction can miss nested structures.** Codex sometimes nests commands in structured args like `bash: { command: "sed file" }` rather than flat `command: "sed file"`. The resolver must check both `toolInput.command` and `toolInput.bash?.command`.

### Symbiont-Specific Skill Target Paths  

**Hand-authored skills need symlinks for non-`.agents` targets.** When manually creating skills (not via `vault_write_skill`), Claude Code and Cursor need symlinks because their manifests declare `skillsTarget: .claude/skills` and `skillsTarget: .cursor/skills` respectively. Check `skillsTarget` in the manifest before assuming `.agents/skills/` is sufficient.

```bash
# Required for manual skill authoring
ln -sf ../../.agents/skills/my-skill .claude/skills/my-skill
ln -sf ../../.agents/skills/my-skill .cursor/skills/my-skill
```