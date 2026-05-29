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
  procedures, API verification discipline, ephemeral sub-invocation capture
  filter for sub-agent phantom defense.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Building and Maintaining a Myco Symbiont Integration

A **symbiont** is an agent or IDE integration (Claude Code, Codex, Cursor, Zed, VS Code, Antigravity) that Myco captures session data from. Adding one requires coordinated changes across five layers: the manifest, hook templates, transcript parser, capture rules, and installer. Each layer has its own file locations and failure modes.

## Prerequisites

- Myco source is checked out and building (`pnpm build` passes)
- You know the target agent's hook lifecycle events (session start, prompt, stop) and where it writes transcript/log files
- You have at least one real session transcript from the target agent to test against
- Familiarity with `packages/myco/src/symbionts/` directory layout: `manifest-schema.ts`, `manifests/`, and `packages/myco/src/capture/` for parsers, rules, installer
- Understanding of Myco's daemon architecture and symbiont manifest structure
- Familiarity with the SQLite schema for sessions, prompt_batches, and lineage edges

---

## Architectural Foundations: Session Lifecycle Management

Sessions are the fundamental unit of developer work, identified by `transcript_path` as the durable key.

### Session Identity and Registry

1. **Use transcript_path as the source of truth** for session identity. Hook lifecycle events are transient; the transcript file persists.

2. **Implement DB-backed session persistence** in the `SessionRegistry` constructor by querying the database for active sessions at startup.

3. **Design status transitions** following the pattern: `active` → `settled` → `archived`

### Session Reactivation Patterns

When a session returns after being settled:

1. **Check existing session record** in the database first
2. **Reactivate with existing session_id** to preserve lineage
3. **Update session metadata** (last_activity, status) but preserve identity
4. **Resume capture** from the last processed position in transcript

---

## Architectural Foundations: Steering Prompt Capture

Steering prompts occur mid-turn when users refine their request. The hierarchical batch model handles this with parent/child relationships.

### Hierarchical Batch Architecture

1. **Use parent_prompt_batch_id** and `kind` taxonomy from `BATCH_KIND`: `initial`, `steering`, `interrupt`

2. **Implement turn boundary detection** by tracking when a new user prompt appears before the previous assistant response completes.

3. **Symbiont-specific detection:**
   - **Claude Code**: Mine JSONL transcripts for `role: "user"` entries between tool_use blocks
   - **Codex**: Detect `turn_id` changes in the event stream
   - **Antigravity**: Parse JSON stdin/stdout for new turn markers (see Procedure 9.3)
   - **OpenCode**: Parse plugin field boundaries in server responses

---

## Architectural Foundations: Response Summary Pipeline

Response summaries provide compact batch descriptions for intelligence processing.

### Stop-Event Processing

Implement the 3-layer fix for robust summary generation in `packages/myco/src/daemon/stop-processing.ts`:

1. **Buffer fallback**: When live events are missed, parse transcript files directly
2. **TUI exit handling**: Detect when TUI-based agents terminate without stop events
3. **Tail widening**: When transcript tail is empty, expand search window

---

## Architectural Foundations: Cross-Symbiont Durability

Capture systems must survive daemon restarts, network issues, and symbiont crashes.

### Registry Persistence Pattern

1. **Store session state** in SQLite sessions table, not just in-memory
2. **Query active sessions at startup** to rebuild the `SessionRegistry` state
3. **Handle partial state** gracefully when transcripts have moved

### Buffer Fallback Mechanisms

For agents like OpenCode and Antigravity that may lose connection:

1. **Implement local buffering** within the plugin/agent
2. **Queue stop events** when daemon is unreachable
3. **Replay buffered events** on reconnection

---

## Architectural Foundations: Cortex Delegation Chain and Subagent Propagation

When agent sessions invoke subagents (e.g., Claude Code running an embedded Claude instance), delegation chains form across symbiont boundaries. Understanding this architecture prevents phantom sessions.

### Cortex Delegation Pattern (PR #354+)

**Problem:** When an agent delegates to a subagent, both have hooks installed. Without proper delegation handling, each creates independent session rows.

**Solution:** Cortex delegation chain propagates session context through environment variables:

```typescript
// Parent agent (Claude Code) sets delegation context
process.env.MYCO_PARENT_SESSION_ID = parentSessionId;
process.env.MYCO_DELEGATION_DEPTH = '1';

// Subagent (Claude CLI) reads context and registers as child
const parentId = process.env.MYCO_PARENT_SESSION_ID;
const depth = parseInt(process.env.MYCO_DELEGATION_DEPTH) || 0;

// Register subagent session with parent linkage
const subagentSession = await registerSubagentSession({
  parentSessionId: parentId,
  delegationDepth: depth + 1,
  transcriptPath: subagentTranscriptPath
});
```

### Subagent Propagation Pattern

**Invariant:** Subagent sessions always capture `parent_session_id` for proper lineage.

**Implementation in manifest:**
```yaml
capture:
  delegation:
    enableParentPropagation: true
    envVarPrefix: MYCO_
    maxDepth: 5
```

**Gotcha:** Don't confuse `parent_session_id` (delegation context) with `session_id` (identity). A subagent session has its own identity but maintains parent linkage.

---

## Procedure 1: Author the Capture Manifest

The manifest is the authoritative description of a symbiont. It lives in `packages/myco/src/symbionts/manifests/<symbiont-id>.yaml` and is validated against `CaptureManifestSchema` at load time.

### 1.1 Manifest-Driven Capture Rules

Move from hardcoded agent-specific logic to declarative rules:

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

### 1.2 registration.mcpCwd Field for Portable MCP Launch

**Problem:** MCP servers spawned from hooks run with the hook's execution context. If the agent changes directories, file resolution breaks.

**Solution:** Add `registration.mcpCwd` to the manifest:

```yaml
registration:
  mcpCwd: /absolute/path  # absolute path, often PROJECT_ROOT
```

When the MCP server spawns, the hook explicitly sets `cwd` before spawning the child process, ensuring portable behavior.

---

## Procedure 2: SDK-Specific MCP Configuration

Different agent SDKs have distinct MCP integration patterns:

### 2.1 Claude SDK Auto-Loading

The Claude SDK automatically loads all user-configured MCP servers, including Myco's. Ensure Myco's MCP server gracefully handles multiple initialization attempts.

### 2.2 OpenAI Strict Function-Calling

OpenAI agents using strict function-calling reject Zod schemas with refinements. Use only basic types without `.refine()` calls.

### 2.3 Claude SDK strictMcpConfig

Ensure Claude SDK-based symbionts pass the correct flags:

```ts
const config = {
  strictMcpConfig: true,
  settingSources: [],  // prevents unwanted config loading
};
```

---

## Procedure 3: Runtime Command Redirection and PATH Collision Handling

### 3.1 Runtime.command Redirect

Some agents need runtime command redirection through Myco's wrapper:

```ts
Runtime.command = 'myco-run';  // redirect through myco wrapper
```

### 3.2 substituteRuntimeCommand Flag

Use the `substituteRuntimeCommand` flag for GUI apps to avoid NODE binary resolution issues:

```yaml
manifest:
  substituteRuntimeCommand: true  # enable PATH collision handling
```

---

## Procedure 4: Universal Stop Buffer Fallback Patterns

All symbionts should implement buffer persistence:

```ts
// Persist buffer state on shutdown signals
process.on('SIGTERM', async () => {
  await persistBufferState();
  await gracefulShutdown();
});

// On startup, check for recovery state
const recoveryState = await checkBufferRecoveryState();
if (recoveryState) {
  await recoverPartialSession(recoveryState);
  await cleanupRecoveryState();
}
```

---

## Procedure 5: Session Validation with scratchProbe()

### 5.1 MYCO_AGENT_SESSION Environment Variable

Set during hook initialization:

```bash
export MYCO_AGENT_SESSION="<session-id>"
```

This ensures all child processes inherit the session context.

### 5.2 scratchProbe() Helper

Call during session startup to validate session state:

```ts
const isValidSession = await scratchProbe(sessionId);
if (!isValidSession) {
  // Skip capture for invalid session
  return;
}
```

---

## Procedure 6: Ephemeral Sub-Invocation Filter — 4th Phantom Defense Layer

**Problem:** Some agents spawn internal LLM sub-invocations (e.g. Codex's UI title generation) that fire `SessionStart`/`UserPromptSubmit` with their own `session_id`. Without filtering, each creates a phantom session.

**Solution:** Add a `session_start` rule in the manifest that `drop`s the phantom on a structural signal. The robust signal is `transcript_path_missing`: real user-facing sessions always have a rollout/transcript file, ephemeral sub-invocations never do. Key on the protocol contract, not on prompt text that can drift. (The `CaptureRule` schema matches via `when:` — `transcript_path_missing` or a `session_meta` dot-path — and supports `drop` / `rewrite_prompt` / `classify`; there is no `source` field.)

```yaml
capture:
  rules:
    # Layer 1 — stop the phantom from ever being registered.
    - event: session_start
      scope: any_agent
      when:
        transcript_path_missing: true
      action: drop
      reason: ephemeral-sub-invocation
    # Layer 2 — safety net for a phantom row that slipped past SessionStart
    #           (e.g. the rollout file hadn't flushed when SessionStart fired).
```

See `codex.yaml` for the live two-layer example. All four phantom defense layers must be present:
1. **Zod schema must accept null** for `transcript_path`
2. **Filter BEFORE daemon wake** via `evaluateSessionStartRules()`
3. **Complete drop filter** covering project path matching, symbiont identity
4. **Ephemeral sub-invocation filter** (`transcript_path_missing` drop) for agents that spawn hooked sub-invocations

---

## Procedure 7: Installer Integration and Skill Discovery

### 7.1 SymbiontInstaller Registration

Register the new symbiont in the `SymbiontInstaller` class:

```ts
symbiont: {
  install: async () => { /* implementation */ },
  update: async () => { /* implementation */ },
  remove: async () => { /* implementation */ },
  doctor: async () => { /* implementation */ },
}
```

### 7.2 Installer Skill Discovery Filtering

Filter skill discovery to SKILL.md files only to avoid false positives:

```ts
const skillFiles = await glob('**/SKILL.md', { cwd: skillsDir });
const skills = skillFiles.map(file => parseSkillFromPath(file));
```

---

## Procedure 8: MCP Tool Registration Verification

### 8.1 Tool Registration Completeness Audit

Implement systematic tool registration verification:

```ts
const advertisedTools = await getAdvertisedMcpTools();
const registeredTools = await getRegisteredMcpTools();

const missingTools = advertisedTools.filter(tool =>
  !registeredTools.includes(tool)
);

if (missingTools.length > 0) {
  console.warn(`Missing tool registrations: ${missingTools.join(', ')}`);
}
```

### 8.2 Integration Testing

Include tool registration verification in symbiont integration tests:

```ts
test('MCP tool registration completeness', async () => {
  const expectedTools = ['tool1', 'tool2', 'tool3'];
  const actualTools = await getMcpToolList();

  expect(actualTools).toEqual(expect.arrayContaining(expectedTools));

  for (const tool of actualTools) {
    expect(await validateToolHandler(tool)).toBe(true);
  }
});
```

---

## Procedure 9: API Verification Discipline

### 9.1 Fetch Authoritative Type Definitions

Always verify against authoritative sources:

```ts
const apiSchema = await fetchApiSchema(agentApiUrl);
const expectedTypes = parseTypeDefinitions(apiSchema);
const implementation = buildParserFromTypes(expectedTypes);
```

### 9.2 Regression Prevention

Build API verification into test suites:

```ts
test('API compatibility verification', async () => {
  const liveApiSchema = await fetchLiveApiSchema();
  const currentImplementation = getCurrentParserSchema();

  expect(isCompatible(currentImplementation, liveApiSchema)).toBe(true);
});
```

### 9.3 Antigravity JSON stdin/stdout Contract

Antigravity uses a JSON-based stdin/stdout contract for agent communication:

```json
// Antigravity stdin format
{
  "type": "prompt",
  "content": "user message",
  "context": { "sessionId": "...", "turnId": "..." }
}

// Antigravity stdout format
{
  "type": "response",
  "content": "assistant message",
  "metadata": { "turnId": "...", "completionTime": 1234 }
}
```

**Implementation:**

```ts
function parseAntigravityTurns(transcript: string): Turn[] {
  const lines = transcript.split('\n').filter(l => l.trim());
  return lines.map(line => {
    const event = JSON.parse(line);
    if (event.type === 'prompt') {
      return { kind: 'user_prompt', content: event.content, turnId: event.context.turnId };
    } else if (event.type === 'response') {
      return { kind: 'assistant_response', content: event.content, turnId: event.metadata.turnId };
    }
  });
}
```

---

## Phantom Session Defense — 4-Layer Pattern

All four layers must be present:

1. **Zod schema must accept null:** `transcript_path: z.string().nullable()`
2. **Filter BEFORE daemon wake:** `evaluateSessionStartRules()` fires first
3. **Complete drop filter:** project path matching, symbiont identity
4. **Ephemeral sub-invocation filter:** `session_start` + `transcript_path_missing` drop rule blocks sub-agent phantoms

---

## Cross-Cutting Gotchas

**Cortex delegation chains preserve lineage** — Parent session ID propagates through subagent invocations via MYCO_PARENT_SESSION_ID. Always set when delegating.

**Antigravity JSON contract is strict** — Respect the exact JSON format. Type mismatches cause parsing failures and phantom sessions.

**registration.mcpCwd is mandatory for portable MCP** — Without this field, MCP servers run with agent-context `cwd`, breaking file resolution. Always set and expand to absolute path.

**source==exec filter in capture rules config** — `source` is environment-variable-based, evaluated by rules engine. Must be in YAML manifest, not hardcoded in hook.

**SDK-specific MCP is critical** — Claude SDK auto-loading, OpenAI strict function-calling, strictMcpConfig, and settingSources all affect success. Test against target SDK.

**Runtime command redirection prevents PATH collisions** — Use Runtime.command redirect and substituteRuntimeCommand for GUI apps.

**Universal stop buffer fallback is required** — All symbionts should implement buffer persistence with agent-specific layering.

**Session validation prevents phantom sessions** — Use MYCO_AGENT_SESSION env var and scratchProbe() to validate integrity.

**Installer skill discovery filters to SKILL.md** — Only discover properly-formatted skill files to prevent false positives.

**Cross-platform hook guard at .agents/myco-run.cjs** — Not .agents/myco-hook.cjs. Always reference the correct filename.

**MCP tool registration must be verified** — Audit completeness to prevent phantom tools and missing handlers.

**API verification prevents inference failures** — Fetch authoritative type definitions rather than inferring from documentation.

**Transcript timing races** — Check file timestamps against DB records. Events may arrive out of order during high activity.

**Registry memory leaks** — Clean up settled sessions periodically. Use `WeakMap` for temporary associations.

**Steering detection false positives** — Code blocks may contain user-like patterns. Validate against actual turn boundaries.

**Event normalization** — Don't assume all symbionts follow same event structure. Use `normalizeHookInput()` for non-standard fields.

**Lineage preservation during fallback** — Maintain proper session → batch → spore edges when using buffer fallback or transcript reconciliation.