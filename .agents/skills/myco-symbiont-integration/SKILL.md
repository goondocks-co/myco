---
name: myco:myco-symbiont-integration
description: >-
  Use this skill when adding or maintaining a Myco symbiont integration,
  or debugging capture-pipeline and installer issues for a supported agent.
  It covers architectural foundations, manifests, hook templates, transcript parsing, image and
  attachment format differences, declarative capture rules, the cross-platform
  hook guard, SymbiontInstaller wiring, installer fixtures, session identity,
  phantom-session defenses, environment-variable injection, transcript
  path parsing failures, registration.mcpCwd field for portable MCP launch,
  SDK-specific MCP configuration requirements (Claude SDK auto-loading,
  OpenAI strict function-calling, strictMcpConfig, settingSources control),
  Runtime.command redirect mechanisms, substituteRuntimeCommand flag for
  PATH collision handling, universal stop buffer fallback patterns, scratchProbe()
  session validation, installer skill discovery, MCP tool registration verification
  procedures, API verification discipline, and source==exec capture filter for
  sub-agent phantom defense.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Building and Maintaining a Myco Symbiont Integration

A **symbiont** is an agent or IDE integration (Claude Code, Codex, Cursor, Zed, VS Code extension, etc.) that Myco captures session data from. Adding one requires coordinated changes across five layers: the manifest, hook templates, transcript parser, capture rules, and installer. Each layer has its own file locations and failure modes. This skill walks through the architectural foundations and all implementation layers in the order you'd encounter them when shipping a new symbiont from scratch, or when modifying an existing one.

## Prerequisites

- Myco source is checked out and building (`pnpm build` passes)
- You know the target agent's hook lifecycle events (session start, prompt, stop) and where it writes transcript/log files
- You have at least one real session transcript from the target agent to test against
- Familiarity with `packages/myco/src/symbionts/` directory layout: `manifest-schema.ts`, `manifests/`, and `packages/myco/src/capture/` for parsers, rules, installer
- Understanding of Myco's daemon architecture and symbiont manifest structure
- Familiarity with the SQLite schema for sessions, prompt_batches, and lineage edges
- Knowledge of TypeScript patterns in `packages/myco/src/daemon/` and symbiont integration points
- Access to symbiont manifest files in `packages/myco/src/symbionts/manifests/`

---

## Architectural Foundations: Session Lifecycle Management

Sessions are the fundamental unit of developer work, identified by `transcript_path` as the durable key. Understanding session architecture is essential before implementing any symbiont integration.

### Session Identity and Registry

1. **Use transcript_path as the source of truth** for session identity. Hook lifecycle events (connect/disconnect) are transient; the transcript file persists.

2. **Implement DB-backed session persistence** in the `SessionRegistry` constructor by querying the database for active sessions at startup.

3. **Design status transitions** following the pattern: `active` → `settled` → `archived`
   - `active`: Session has recent activity or open connections
   - `settled`: No recent activity but transcript still accessible  
   - `archived`: Transcript moved or session explicitly closed

### Session Reactivation Patterns

When a session returns after being settled:

1. **Check existing session record** in the database first
2. **Reactivate with existing session_id** to preserve lineage
3. **Update session metadata** (last_activity, status) but preserve identity
4. **Resume capture** from the last processed position in transcript

Example reactivation logic in session management:
```typescript
const existingSession = await db.getSessionByTranscriptPath(transcript_path);
if (existingSession) {
  session = await this.reactivateSession(existingSession);
} else {
  session = await this.createNewSession(transcript_path);
}
```

---

## Architectural Foundations: Steering Prompt Capture

Steering prompts occur mid-turn when users refine their request. The hierarchical batch model handles this with parent/child relationships.

### Hierarchical Batch Architecture

1. **Design the batch hierarchy** using `parent_prompt_batch_id` and `kind` taxonomy from `BATCH_KIND`:
   - `initial`: First prompt in a turn (parent batch)
   - `steering`: Mid-turn refinement (child of initial)
   - `interrupt`: User interruption during assistant response

2. **Implement turn boundary detection** by tracking when a new user prompt appears before the previous assistant response completes.

3. **Create child batches** for steering prompts using `insertBatchStateless`:
   ```typescript
   const steeringBatch = {
     parent_prompt_batch_id: parentBatch.id,
     kind: BATCH_KIND.STEERING,
     user_prompt: newPromptText,
     session_id: session.id
   };
   ```

### Symbiont-Specific Detection

Each symbiont has different transcript formats requiring specialized detection:

**Claude Code**: Mine JSONL transcripts for `role: "user"` entries between tool_use blocks
**Codex**: Detect `turn_id` changes in the event stream  
**OpenCode**: Parse plugin field boundaries in server responses

Example Claude Code detection in `packages/myco/src/capture/prompt-kind.ts`:
```typescript
function detectSteeringInClaudeCode(events: HookEvent[]): boolean {
  // Use classifyNextPromptKind with manifest rules to classify prompt timing
  const promptKinds = extractUserPromptKinds(events, transcriptPath);
  return promptKinds.some(kind => kind.steering);
}
```

---

## Architectural Foundations: Response Summary Pipeline

Response summaries provide compact batch descriptions for intelligence processing.

### Stop-Event Processing

Implement the 3-layer fix for robust summary generation in `packages/myco/src/daemon/stop-processing.ts`:

1. **Buffer fallback**: When live events are missed, parse transcript files directly using `enrichTurnsWithToolMetadata`
2. **TUI exit handling**: Detect when TUI-based agents terminate without stop events
3. **Tail widening**: When transcript tail is empty, expand search window

### Summary Routing Decisions

Route summaries to the correct batch based on turn structure using the parent traversal logic:

**Rule**: Summary belongs on the parent batch when the latest batch is a steering child

Example routing logic:
```typescript
function determineSummaryTarget(latestBatch: PromptBatch): string {
  // Walk up parent chain to find the root parent for steering children
  while (current?.parent_prompt_batch_id != null) {
    const parent = getBatchById(current.parent_prompt_batch_id);
    if (!parent) break;
    current = parent;
  }
  return current?.id || latestBatch.id;
}
```

This ensures response summaries appear on the main conversation flow, not scattered across steering children.

---

## Architectural Foundations: Cross-Symbiont Durability

Capture systems must survive daemon restarts, network issues, and symbiont crashes.

### Registry Persistence Pattern

Implement database-backed session recovery:

1. **Store session state** in SQLite sessions table, not just in-memory
2. **Query active sessions at startup** to rebuild the `SessionRegistry` state  
3. **Handle partial state** gracefully when transcripts have moved

```typescript
async initializeFromDatabase() {
  const activeSessions = await this.db.getSessionsByStatus('active');
  for (const sessionData of activeSessions) {
    if (await this.transcriptExists(sessionData.transcript_path)) {
      await this.addExistingSession(sessionData);
    } else {
      await this.markSessionArchived(sessionData.id);
    }
  }
}
```

### Buffer Fallback Mechanisms

For agents like OpenCode that may lose connection:

1. **Implement local buffering** within the plugin/agent
2. **Queue stop events** when daemon is unreachable
3. **Replay buffered events** on reconnection

### SIGTERM Handling

The three-layer OpenCode SIGTERM fix provides a durability template:

1. **DB-backed registry**: Session state survives daemon restart
2. **Scope fix**: `any_agent` rules only match known agents or unknown events
3. **Plugin buffer fallback**: Local event storage for network issues

---

## Procedure 1: Author the Capture Manifest

The manifest is the authoritative description of a symbiont. It lives in `packages/myco/src/symbionts/manifests/<symbiont-id>.yaml` and is validated against `CaptureManifestSchema` at load time.

### 1.1 Building Manifest-Driven Capture Rules

Move from hardcoded agent-specific logic to declarative manifest-driven capture.

#### Generic Walker Architecture

1. **Use the unified capture rule functions** in `packages/myco/src/capture/prompt-kind.ts` and `packages/myco/src/hooks/capture-rules.ts` instead of agent-specific walkers.

2. **Define capture rules in symbiont manifests** at `packages/myco/src/symbionts/manifests/*.json`:
   ```json
   {
     "capture": {
       "prompts": {
         "detector": "jsonl_role_user",
         "boundaries": ["tool_use", "assistant_end"]
       },
       "attachments": {
         "patterns": ["*.md", "*.ts"],
         "max_size": 102400
       }
     }
   }
   ```

3. **Implement domain-keyed schemas** using the `CaptureRule` type from `packages/myco/src/symbionts/manifest-schema.ts`:
   ```typescript
   interface CaptureConfig {
     prompts: PromptCaptureRule;
     attachments?: AttachmentCaptureRule;
     events?: EventCaptureRule;
   }
   ```

#### Hook Purity Pattern

Keep hooks as pure proxies, moving all capture logic daemon-side:

1. **Hooks forward events** without classification or processing
2. **Daemon inspects transcripts** using manifest rules in `packages/myco/src/hooks/capture-rules.ts`
3. **No silent crashes** on unknown transcript shapes - log and skip instead

### 1.2 registration.mcpCwd Field for Portable MCP Launch

**Problem:** MCP servers spawned from hooks run with `cwd` from the hook's execution context. If the agent changes directories between hook invocation and MCP spawn, the MCP process uses a different working directory, breaking file resolution for relative paths in MCP payloads.

**Solution:** Add `registration.mcpCwd` to the manifest:

```yaml
registration:
  mcpCwd: /absolute/path  # absolute path, often PROJECT_ROOT
```

This path is stored in the generated hook script at install time. When the MCP server spawns, the hook explicitly sets `cwd` to `mcpCwd` **before** spawning the child process:

```bash
cd "$MYCO_MCP_CWD" && node packages/myco/bin/myco-run ...  # spawn with fixed cwd
```

This ensures portable MCP behavior regardless of where the agent changes directory. Always set this field in the manifest and always expand it to an absolute path at install time.

---

## Procedure 2: SDK-Specific MCP Configuration

Different agent SDKs have distinct MCP integration patterns and requirements that affect symbiont design:

### 2.1 Claude SDK Auto-Loading Behavior

**Issue:** The Claude SDK automatically loads all user-configured plugins and MCP servers, including Myco's MCP server. This can create initialization conflicts or duplicate tool registrations if not handled properly.

**Solution:** Ensure Myco's MCP server gracefully handles multiple initialization attempts and doesn't conflict with other user MCP configurations.

### 2.2 OpenAI Strict Function-Calling Incompatibilities

**Issue:** OpenAI agents using strict function-calling mode reject Zod schemas with refinements (`.refine()` calls), causing MCP tool registration failures.

**Solution:** For OpenAI-compatible symbionts, ensure MCP tool schemas use only basic Zod types without refinements:

```ts
// AVOID for OpenAI strict function-calling
const schema = z.string().refine(s => s.length > 0);

// USE instead
const schema = z.string().min(1);
```

### 2.3 Claude SDK strictMcpConfig and settingSources Control

**Issue:** The Claude SDK requires `strictMcpConfig: true` in its configuration to properly validate MCP server registration and tool schemas. Additionally, the Claude SDK's `settingSources: []` controls which configuration sources are loaded.

**Solution:** Ensure Claude SDK-based symbionts pass the correct flags:

```ts
// Required for Claude SDK
const config = {
  strictMcpConfig: true,
  settingSources: [], // empty array prevents unwanted config loading
  // ... other config
};
```

The `settingSources: []` setting prevents the SDK from loading configuration that might conflict with Myco's MCP setup.

---

## Procedure 3: Runtime Command Redirection and PATH Collision Handling

### 3.1 Runtime.command Redirect Mechanism

**Issue:** Some agents (particularly OpenCode) need to redirect runtime commands through Myco's execution wrapper to ensure proper session context and capture pipeline integration.

**Solution:** Use the Runtime.command redirect mechanism in `packages/myco/bin/myco-run`:

```ts
// In the agent's runtime configuration
Runtime.command = 'myco-run';  // redirect through myco wrapper
```

This ensures that command execution goes through Myco's capture pipeline, maintaining session context and proper logging.

### 3.2 substituteRuntimeCommand Flag for PATH Collision Issues

**Issue:** GUI applications (like OpenCode) can have PATH collisions where the system `node` binary differs from the development `node` binary, causing runtime command failures.

**Solution:** Use the `substituteRuntimeCommand` flag in the manifest:

```yaml
manifest:
  substituteRuntimeCommand: true  # enable PATH collision handling
  # ... other config
```

When this flag is enabled, Myco will substitute the runtime command with an absolute path to avoid PATH-based resolution issues.

### 3.3 PATH Collision Gotchas with GUI Apps

**Common Issue:** GUI applications don't inherit shell PATH modifications (nvm, volta, etc.), causing `node` command resolution to fail or use the wrong binary.

**Symptoms:**
- `env: node: No such file or directory`
- Runtime using system Node instead of development Node
- MCP server startup failures in GUI context

**Fix:** Always use absolute paths for Node binary resolution in GUI-launched contexts:

```ts
const nodeBin = process.execPath;  // absolute path to current node
spawn(nodeBin, ['script.js'], { ... });
```

---

## Procedure 4: Universal Stop Buffer Fallback Patterns

Agent integrations commonly need stop buffer fallback patterns to handle graceful shutdown and prevent data loss. This pattern applies universally, not just to specific agents like OpenCode.

### 4.1 Buffer Persistence Strategy

**Issue:** When agents terminate unexpectedly or receive termination signals, in-memory buffers can be lost, resulting in incomplete session captures.

**Solution:** Implement buffer persistence across all symbiont integrations:

```ts
// Persist buffer state on shutdown signals
process.on('SIGTERM', async () => {
  await persistBufferState();
  await gracefulShutdown();
});

process.on('SIGINT', async () => {
  await persistBufferState(); 
  await gracefulShutdown();
});
```

### 4.2 Recovery Mechanisms

**Pattern:** On startup, check for persisted buffer state and recover partial sessions:

```ts
// On symbiont startup, check for recovery state
const recoveryState = await checkBufferRecoveryState();
if (recoveryState) {
  await recoverPartialSession(recoveryState);
  await cleanupRecoveryState();
}
```

### 4.3 OpenCode-Specific Three-Layer Implementation

OpenCode requires additional layers beyond the universal pattern due to registry rehydration and scope semantics:

**Layer 1 — Registry Rehydration:**
```ts
// Force registry refresh on SIGTERM recovery
await rehydrateSymbiontRegistry();
```

**Layer 2 — Scope Semantics:**
```ts
process.on('SIGTERM', async () => {
  await flushPartialScope();  // complete any in-progress scope
  await persistBufferState(); // universal pattern
  await gracefulShutdown();
});
```

**Layer 3 — Buffer Fallback:** Uses the universal pattern above.

---

## Procedure 5: Session Validation with scratchProbe() and MYCO_AGENT_SESSION

### 5.1 MYCO_AGENT_SESSION Environment Variable

**Purpose:** The `MYCO_AGENT_SESSION` environment variable provides session context to sub-processes and helps validate session boundaries.

**Usage:** Set during hook initialization:

```bash
export MYCO_AGENT_SESSION="<session-id>"
# ... launch agent with session context
```

This ensures that all child processes inherit the session context, enabling proper session validation and preventing phantom session creation.

### 5.2 scratchProbe() Helper for Session Validation

**Purpose:** The `scratchProbe()` helper function validates session integrity and prevents corrupt session creation.

**Usage:** Call during session startup to validate session state:

```ts
// Validate session before proceeding with capture
const isValidSession = await scratchProbe(sessionId);
if (!isValidSession) {
  // Skip capture for invalid session
  return;
}
```

This helper checks for:
- Session ID validity
- Transcript path accessibility  
- Hook registration status
- Environment variable consistency

---

## Procedure 6: source==exec Filter — 4th Phantom Defense Layer

**Problem:** Codex spawns sub-agent processes (e.g., to run `node` or `python` commands). These sub-agents also have hooks installed and fire their own `session_start` events. Without filtering, each sub-agent invocation creates phantom sessions.

**Solution:** Add a rule in the manifest (or capture rules config) to filter `source==exec` calls:

```yaml
capture:
  rules:
    - source: exec
      event: session_start
      action: skip
      reason: Filter Codex sub-agent spawns (source==exec prevents phantom session creation)
```

When an agent is invoked as a sub-process (source=exec in the environment), this rule drops its events before daemon wake, preventing nested sessions. This is the **4th layer** of phantom session defense:

1. **Layer 1 — Zod schema nullable:** `transcript_path: z.string().nullable()`
2. **Layer 2 — Filter before daemon wake:** `evaluateSessionStartRules()` before `ensureRunning()`
3. **Layer 3 — Complete drop filter:** Project path matching, symbiont identity validation
4. **Layer 4 — source==exec filter:** Block sub-agent invocations by source context

All four layers must be present.

---

## Procedure 7: Installer Integration and Skill Discovery

### 7.1 SymbiontInstaller Registration

Register the new symbiont in the `SymbiontInstaller` class with install, update, remove, and doctor methods:

```ts
// In packages/myco/src/capture/installer/index.ts
symbiont: {
  install: async () => { /* implementation */ },
  update: async () => { /* implementation */ }, 
  remove: async () => { /* implementation */ },
  doctor: async () => { /* implementation */ },
}
```

### 7.2 Installer Skill Discovery Filtering

**Issue:** The installer needs to discover available skills but should filter to only SKILL.md files to avoid false positives from other markdown files.

**Solution:** Implement skill discovery filtering in the installer:

```ts
// Filter skill discovery to SKILL.md files only
const skillFiles = await glob('**\\/SKILL.md', { cwd: skillsDir });
const skills = skillFiles.map(file => parseSkillFromPath(file));
```

This ensures that only properly-formatted skill files are discovered and registered, preventing the installer from picking up unrelated markdown files as skills.

---

## Procedure 8: MCP Tool Registration Verification

### 8.1 Tool Registration Completeness Audit

**Issue:** Symbiont integrations may have incomplete MCP tool registration, where some tools are advertised but not actually available, or phantom tools are referenced that don't exist.

**Solution:** Implement systematic tool registration verification:

```ts
// Verify all advertised tools are actually registered
const advertisedTools = await getAdvertisedMcpTools();
const registeredTools = await getRegisteredMcpTools();

const missingTools = advertisedTools.filter(tool => 
  !registeredTools.includes(tool)
);

const phantomTools = registeredTools.filter(tool => 
  !isValidToolHandler(tool)
);

if (missingTools.length > 0) {
  console.warn(`Missing tool registrations: ${missingTools.join(', ')}`);
}

if (phantomTools.length > 0) {
  console.warn(`Phantom tool references: ${phantomTools.join(', ')}`);
}
```

### 8.2 Tool Registration Verification During Integration Testing

**Pattern:** Include tool registration verification in symbiont integration tests:

```ts
// Test that all expected tools are properly registered
test('MCP tool registration completeness', async () => {
  const expectedTools = ['tool1', 'tool2', 'tool3']; 
  const actualTools = await getMcpToolList();
  
  expect(actualTools).toEqual(expect.arrayContaining(expectedTools));
  
  // Verify no phantom tools
  for (const tool of actualTools) {
    expect(await validateToolHandler(tool)).toBe(true);
  }
});
```

This prevents deployment of symbionts with incomplete or broken tool registration.

---

## Procedure 9: API Verification Discipline

### 9.1 Fetch Authoritative Type Definitions

**Issue:** When integrating with external agent APIs, inferring behavior from documentation or assumptions can lead to implementation failures. Always verify against authoritative sources.

**Solution:** Fetch actual type definitions and API specifications before implementing:

```ts
// CORRECT: Fetch authoritative types
const apiSchema = await fetchApiSchema(agentApiUrl);
const expectedTypes = parseTypeDefinitions(apiSchema);

// Use verified types for implementation
const implementation = buildParserFromTypes(expectedTypes);
```

**Anti-pattern:** Inferring API behavior without verification:
```ts
// AVOID: Inference without verification
const assumedSchema = {
  // ... assumptions that may be wrong
};
```

### 9.2 Regression Prevention via API Verification

**Pattern:** Build API verification into the integration test suite:

```ts
// Verify current implementation matches live API
test('API compatibility verification', async () => {
  const liveApiSchema = await fetchLiveApiSchema();
  const currentImplementation = getCurrentParserSchema();
  
  expect(isCompatible(currentImplementation, liveApiSchema)).toBe(true);
});
```

This ensures that symbiont integrations stay current with evolving agent APIs and prevents "inference over verification" failure modes.

---

## Vault Location Resolution

The vault is always `<git-repo-root>/.myco/`. There are no env var overrides — `resolveVaultDir()` walks up to the git common dir and appends `.myco`. If a symbiont's MCP child or hook would otherwise launch with a cwd that breaks discovery, fix it at the launch surface (e.g. set `registration.mcpCwd` in the manifest), not by injecting `MYCO_VAULT_DIR` or `MYCO_PROJECT_ROOT` — those env vars are no longer honored.

---

## Phantom Session Defense — 4-Layer Pattern (Updated)

A phantom session is a vault row created for an interaction that should have been filtered out. All four layers must be present:

**Layer 1 — Zod schema must accept null:**
```typescript
transcript_path: z.string().nullable()  // CORRECT
```

**Layer 2 — Filter BEFORE daemon wake:**
```typescript
// CORRECT — filter fires first; daemon only wakes if session passes
const shouldDrop = await evaluateSessionStartRules(payload);
if (shouldDrop) return;
await ensureRunning();
```

**Layer 3 — Complete drop filter covering:** project path matching, symbiont identity, hook phase suppression, duplicate detection.

**Layer 4 — source==exec filter for sub-agent invocations:**
```yaml
capture:
  rules:
    - source: exec
      action: skip
      reason: Drop Codex sub-agent spawns
```

Verify: stop the daemon, trigger a drop condition (e.g., null transcript_path, or source=exec), confirm `myco daemon status` still reports stopped.

---

## Cross-Cutting Gotchas

**Transcript timing races**: Always check transcript file timestamps against database records. Events may arrive out of order during high activity.

**Registry memory leaks**: Clean up settled sessions periodically. Use `WeakMap` for temporary session associations.

**Steering detection false positives**: Mid-conversation code blocks or examples may contain user-like patterns. Validate against actual turn boundaries.

**Summary routing edge cases**: When parent batches have no direct prompts (only steering children), ensure summaries still have a valid target.

**Event normalization assumptions**: Don't assume all symbionts follow the same event structure. Use `normalizeHookInput()` for non-standard fields.

**Lineage preservation during fallback**: When using buffer fallback or transcript reconciliation, maintain proper session → batch → spore lineage edges.

**registration.mcpCwd is mandatory for portable MCP** — Without this field, MCP servers spawned from hooks run with agent-context `cwd`, breaking file resolution. Always set this in the manifest and expand to absolute path at install time.

**source==exec filter must be in capture rules config** — `source` is an environment-variable-based filter evaluated by the rules engine. Ensure the filter is present in the YAML manifest, not hardcoded in the hook.

**SDK-specific MCP considerations are critical** — Claude SDK auto-loading, OpenAI strict function-calling limitations, Claude SDK strictMcpConfig requirements, and settingSources control all affect symbiont integration success. Test against target SDK behavior patterns, not just generic MCP specifications.

**Runtime command redirection prevents PATH collisions** — Use Runtime.command redirect and substituteRuntimeCommand flag for GUI applications to avoid NODE binary resolution issues.

**Universal stop buffer fallback is required** — All symbionts should implement buffer persistence and recovery patterns, with agent-specific layering (like OpenCode's three-layer pattern) as needed.

**Session validation prevents phantom sessions** — Use MYCO_AGENT_SESSION env var and scratchProbe() helper to validate session integrity before capture.

**Installer skill discovery must filter to SKILL.md** — Only discover properly-formatted skill files to prevent false positives from other markdown files.

**Cross-platform hook guard location** — The hook guard is located at `.agents/myco-run.cjs`, not `.agents/myco-hook.cjs`. Always reference the correct filename.

**MCP tool registration must be verified** — Audit tool registration completeness during integration to prevent phantom tools and missing tool handlers.

**API verification prevents inference failures** — Always fetch authoritative type definitions from external APIs rather than inferring behavior from documentation. Build verification into test suites.