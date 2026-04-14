---
name: myco:myco-symbiont-integration
description: >-
  Use this skill when adding or maintaining a Myco symbiont integration,
  or debugging capture-pipeline and installer issues for a supported agent.
  It covers manifests, hook templates, transcript parsing, image and
  attachment format differences, declarative capture rules, the cross-platform
  hook guard, SymbiontInstaller wiring, installer fixtures, session identity,
  phantom-session defenses, environment-variable injection, and transcript
  path parsing failures.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Building and Maintaining a Myco Symbiont Integration

A **symbiont** is an agent or IDE integration (Claude Code, Codex, Cursor, Zed, VS Code extension, etc.) that Myco captures session data from. Adding one requires coordinated changes across five layers: the manifest, hook templates, transcript parser, capture rules, and installer. Each layer has its own file locations and failure modes. This skill walks through all of them in the order you'd encounter them when shipping a new symbiont from scratch, or when modifying an existing one.

## Prerequisites

- Myco source is checked out and building (`pnpm build` passes)
- You know the target agent's hook lifecycle events (session start, prompt, stop) and where it writes transcript/log files
- You have at least one real session transcript from the target agent to test against
- Familiarity with `src/capture/` directory layout: `manifest-schema.ts`, `parsers/`, `rules/`, `installer/`

---

## Procedure 1: Author the Capture Manifest

The manifest is the authoritative description of a symbiont. It lives in `src/capture/manifests/<symbiont-id>.ts` and is validated against `CaptureManifestSchema` at load time.

### 1.1 Define the manifest file

```ts
// src/capture/manifests/my-agent.ts
import type { CaptureManifest } from '../manifest-schema.js';

export const myAgentManifest: CaptureManifest = {
  id: 'my-agent',           // kebab-case, unique across all symbionts
  displayName: 'My Agent',
  agentId: 'my-agent',      // used as agent_id in DB rows
  planDirs: [               // directories where plan files appear
    '.my-agent/plans',
  ],
  planTags: ['my-agent'],   // tags applied to captured plans
  rules: {
    // See Procedure 4 for rule configuration
  },
};
```

**Key fields:** `id` and `agentId` must be stable (they key DB rows). `planDirs` is relative to project root.

### 1.2 Export from the manifest registry

Add to `src/capture/manifests/index.ts` and register in `src/capture/registry.ts` (or wherever `ALL_MANIFESTS` is assembled).

### 1.3 Verify schema compliance

```bash
pnpm build
# CaptureManifestSchema validates at import time; build failures mean schema mismatch
```

---

## Procedure 2: Create Hook Templates

### 2.1 Locate existing templates

```
src/installer/templates/<symbiont-id>/
  session-start.sh   prompt.sh   session-stop.sh
```

Copy the closest existing template directory and rename it.

### 2.2 Wire `--symbiont` argv binding

Every hook must identify itself with `--symbiont <id>`:

```bash
#!/bin/bash
node "$MYCO_HOOK_SCRIPT" \
  --symbiont my-agent \
  --event session-start \
  --session-id "$MY_AGENT_SESSION_ID" \
  --project-root "$MY_AGENT_PROJECT_ROOT"
```

**Argv-first detection rule:** The daemon reads `--symbiont` from process argv before env vars. Always pass `--symbiont` explicitly; never rely on `MYCO_SYMBIONT` env alone.

### 2.3 Integrate the cross-platform hook guard

```bash
#!/bin/bash
if [ ! -f ".agents/myco-hook.cjs" ]; then exit 0; fi
node .agents/myco-hook.cjs --check || exit 0
# ... rest of hook
```

The guard file is written by `myco install`. It is safe to check into `.agents/`. Never contains secrets.

### 2.4 Template variable substitution

Template files use `{{VARIABLE}}` placeholders replaced by `SymbiontInstaller.renderTemplate()` at install time. Common: `{{MYCO_HOOK_SCRIPT}}`, `{{SYMBIONT_ID}}`, `{{PROJECT_ROOT}}`.

---

## Procedure 3: Implement the TranscriptParser

### 3.1 Interface contract

```ts
export interface TranscriptParser {
  parseTurns(content: string): TranscriptTurn[];
}
export interface TranscriptTurn {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  timestamp?: string;
}
```

### 3.2 Create the parser class

Follow the naming pattern `<AgentName>JsonlParser`. Parse JSONL lines, skip malformed entries. Export from `src/capture/parsers/index.ts` and wire in the parser factory.

### 3.3 Handle multi-message assistant turns

Some agents emit multiple consecutive JSONL entries for a single assistant turn. Coalesce consecutive entries with `role === 'assistant'` into one turn by appending content blocks.

### 3.4 Plugin-boundary normalization

Strip plugin preamble text at the start of assistant messages using a `PREAMBLE_PATTERNS` array. Keep patterns agent-specific and extensible.

### 3.5 TranscriptParser must be stateless

`parseTurns()` is called once per batch. Scope coalescing state to the function call, not the class instance — stateful parsers cause cross-batch contamination when the parser is reused.

---

## Procedure 4: Configure Declarative Capture Rules

### 4.1 Manifest-level rule fields

```ts
rules: {
  scope?: 'project' | 'global';
  drop?: string[];                      // glob patterns to exclude
  extract_after?: string;               // only capture turns after this marker
  transcript_path_missing?: 'skip' | 'warn' | 'error'; // default: 'warn'
}
```

Use `transcript_path_missing: 'skip'` for agents that write transcripts lazily (Codex). Use `'warn'` for agents that should always have a transcript.

### 4.2 Per-event filtering rules DSL

Lives in the YAML manifest. The evaluator (`evaluateUserPromptRules()` in `src/hooks/capture-rules.ts`) applies it at runtime.

```yaml
capture:
  rules:
    - event: session_start
      scope: any_agent
      action: skip
      reason: Codex emits phantom session_start events before agent identity resolves
```

### 4.3 Choosing `scope` — the most critical decision

- **`scope: this_agent`** — fires only after agent identity is resolved. Use for mid-session events.
- **`scope: any_agent`** — fires regardless of whether identity is resolved. **Required for early-lifecycle events** (`session_start`, first `user_prompt`).

**The phantom session gotcha:** phantom suppression almost always needs `scope: any_agent`. Using `scope: this_agent` for a `session_start` rule silently does nothing — no error, just a ghost session in the vault.

### 4.4 Additional rule pitfalls

- **Rule order matters** — evaluator applies the first matching rule; put specific rules before broad catch-alls for the same event
- **`when` fails silently on grammar errors** — condition evaluates to `false` with no error; prefer simple equality checks; check the evaluator's supported grammar before writing complex expressions

---

## Procedure 5: Handle Image and Attachment Formats

Claude Code sends raw base64 in `source.data` (`type: "image"`). Codex wraps images in `input_image` with `image_url.url` as a data URL (includes `data:image/...;base64,` prefix).

Normalize to a common internal `ImageBlock` type, always stripping the data URL prefix before storing. Never store data URLs internally — always strip to raw base64. Use a `normalizeImage()` function rather than ad-hoc string slicing to avoid double-encoding.

---

## Procedure 6: Register in SymbiontInstaller

Create a class extending `SymbiontInstaller` in `src/installer/symbionts/MyAgentInstaller.ts`. Implement `install`, `update`, `remove`, and `doctor`. Register in `src/installer/index.ts`.

**Do not** remove `.agents/myco-hook.cjs` in your `remove()` — that file is shared across all symbionts. Remove only hooks specific to your symbiont.

---

## Procedure 7: Write and Maintain Installer Tests

Fixtures live in `src/installer/__tests__/fixtures/<symbiont-id>/` as **copies** (not symlinks) of the template files. **When you update a hook template, update the corresponding fixture in the same commit** — fixture drift produces tests that pass in CI but verify the wrong behavior in production.

```bash
# After editing a template, sync the fixture:
diff src/installer/templates/my-agent/session-start.sh \
     src/installer/__tests__/fixtures/my-agent/session-start.sh
cp src/installer/templates/my-agent/session-start.sh \
   src/installer/__tests__/fixtures/my-agent/session-start.sh
pnpm test --updateSnapshot
```

Write three tests minimum: install creates hooks, doctor reports healthy, remove leaves hook guard intact.

---

## Debugging the Capture Pipeline

Work through these in order when a symbiont isn't capturing, sessions are duplicated or mis-attributed, or hooks are silently failing.

### Session Identity

Session identity flows from `transcript_path` (canonical durable key). Hook lifecycle events carry no identity guarantee. The daemon must query for an existing session by `transcript_path` before inserting a new row.

- If `transcript_path` arrives as `null`: drop the event immediately. Never construct a synthetic path (e.g., from timestamp + sessionId) — a synthetic path will never match future hook payloads and generates duplicate session rows.
- Check for duplicates: `SELECT id, transcript_path, created_at FROM sessions WHERE transcript_path LIKE '%<partial-path>%'`
- Session lineage (parent/child) is an **agent intelligence task**, not a daemon task.

### Phantom Session Defense — 3-Layer Pattern

A phantom session is a vault row created for an interaction that should have been filtered out. All three layers must be present:

**Layer 1 — Zod schema must accept null:**
```typescript
transcript_path: z.string().nullable()  // CORRECT
// not: z.string()  — throws on null, bypasses downstream filters
```

**Layer 2 — Filter BEFORE daemon wake (most common mistake):**
```typescript
// CORRECT — filter fires first; daemon only wakes if session passes
const shouldDrop = await evaluateSessionStartRules(payload);
if (shouldDrop) return;
await ensureRunning();

// WRONG — daemon is already active before filter can stop it
await ensureRunning();
const shouldDrop = await evaluateSessionStartRules(payload);
if (shouldDrop) return;  // too late
```

**Layer 3 — Complete drop filter covering:** project path matching, symbiont identity, hook phase suppression, duplicate detection.

Verify: stop the daemon, trigger a drop condition (e.g., null transcript_path), confirm `myco daemon status` still reports stopped.

### Hook Entry Point Architecture

Hooks and MCP servers have mutually exclusive path resolution requirements:

| Context | Entry Point | Path Resolution |
|---------|-------------|-----------------|
| Hooks | `.agents/myco-run.cjs` | **cwd-relative** — trusts `process.cwd()` as project root |
| MCP server | `bin/myco-run` | **self-locating** — uses `fs.realpathSync(__filename)` |

Using `bin/myco-run` as a hook target fails when the agent changes directories. The cross-platform hook guard (`.agents/myco-hook.cjs`) pins `cwd` to the project root before delegating, preventing CWD drift.

### Env Var Propagation

Claude Code injects env vars from `settings.json` into hook processes, but **not** from `settings.user.json`. Any env var required by a hook must live in `settings.json`. `MYCO_CMD` is deprecated — hooks now locate the daemon via `.myco/runtime.command`, written by the daemon at startup.

```bash
cat .myco/runtime.command   # verify populated after daemon start
```

### Transcript Path Parsing Failures

- **Claude Code:** `transcript_path` reliably populated in SessionStart; format: `~/.claude/projects/<hash>/<uuid>.jsonl`
- **Codex:** may use nested transcript directory structure; `findTranscript()` may need `{ recursive: true }` to locate the file one level deeper than the flat directory default
- **All symbionts:** verify the path exists on disk before writing the session row; use `sessionId` as a fallback key only if `transcript_path` is null, and log a warning — the session cannot be deduplicated by path

---

## Cross-Cutting Gotchas

**Argv vs env var for symbiont identity** — Always pass `--symbiont <id>` explicitly in every hook. If argv is absent and `MYCO_SYMBIONT` env is accidentally inherited from a parent process, the wrong manifest gets applied.

**Base64 double-encoding** — Always strip the `data:...;base64,` prefix before storing. Use the `normalizeImage()` pattern rather than ad-hoc string slicing.

**Hook guard is shared infrastructure** — Use `installHookGuard()` from the base class (idempotent). Do not remove it in your symbiont's `remove()`.

**TranscriptParser must be stateless** — Scope all coalescing state to the function call, not the class instance.

**`pnpm build` is the schema validator** — `CaptureManifestSchema` validates at import time. Always run `pnpm build` after manifest changes, not just `tsc --noEmit`.

**Phantom sessions require `scope: any_agent` rules** — Using `scope: this_agent` for session_start rules silently fails when agent identity hasn't been established yet.

**Agent sub-sessions appear as top-level sessions** — Sub-agents spawned by a symbiont fire their own hooks. Suppress them with per-event filtering rules (Procedure 4.3), not hook template changes.

**Filter ordering is the #1 phantom source** — `evaluateSessionStartRules()` must always precede `ensureRunning()`. Verify this ordering whenever a hook handler is refactored or merged.

---

## Checklist: Capture-Ready Symbiont

- [ ] `transcript_path` schema accepts `string | null`; null triggers an immediate drop without calling `ensureRunning()`
- [ ] `evaluateSessionStartRules()` is called **before** `ensureRunning()` in all hook handlers
- [ ] Hooks use `.agents/myco-run.cjs` (cwd-relative); MCP uses `bin/myco-run` (self-locating)
- [ ] All required env vars are in `settings.json`, not `settings.user.json`; `MYCO_CMD` is absent
- [ ] `findTranscript()` covers the symbiont's directory structure (recursive if needed); path existence validated before write
- [ ] Phantom session rules use `scope: any_agent` for early-lifecycle events
- [ ] Hook template fixtures are in sync with templates; installer tests cover install/doctor/remove
