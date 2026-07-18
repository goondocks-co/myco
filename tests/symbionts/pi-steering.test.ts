import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'bun:test';
import { TOOL_DEFINITIONS } from '@myco/tools/definitions.js';

// These tests pin the structural shape of the Pi plugin — the exact event
// names it subscribes to and the data it forwards to the daemon. They are
// grep-style because the plugin runs inside Pi's Bun runtime and can't be
// easily unit-executed from Vitest. An earlier revision of the plugin moved
// capture onto speculative `turn_start` / `turn_end` events that don't exist
// in the Pi API, silently breaking capture for fresh Pi sessions — these
// tests exist so the regression can't repeat.

function pluginSource(): string {
  const pluginPath = path.resolve(
    import.meta.dirname ?? __dirname,
    '../../packages/myco/src/symbionts/templates/pi/plugin.ts',
  );
  return fs.readFileSync(pluginPath, 'utf-8');
}

describe('Pi plugin', () => {
  it('captures user prompts on before_agent_start', () => {
    const source = pluginSource();
    expect(source).toContain('pi.on("before_agent_start"');
    // The before_agent_start handler must post the prompt and assign the
    // returned batch id to `currentParentBatchId` so subsequent `input`
    // events can be classified as steering.
    expect(source).toMatch(/before_agent_start[\s\S]*mycoPostUserPrompt[\s\S]*currentParentBatchId\s*=\s*result\.batchId/);
  });

  it('captures steering prompts on the input event while a turn is in flight', () => {
    const source = pluginSource();
    expect(source).toContain('pi.on("input"');
    // Steering classification gates on `currentParentBatchId !== null` (the
    // non-null batch id is the in-flight signal) and drops extension-
    // synthesized inputs. BATCH_KIND.STEERING is the canonical kind token.
    expect(source).toMatch(/pi\.on\("input"[\s\S]*currentParentBatchId === null[\s\S]*source === "extension"[\s\S]*BATCH_KIND\.STEERING/);
  });

  it('does NOT subscribe to queue_update — that event is session-internal, not extension-exposed', () => {
    // Pi emits queue_update on its internal AgentSessionEvent stream only.
    // Extensions must use the `input` event for mid-turn steering capture.
    const source = pluginSource();
    expect(source).not.toContain('pi.on("queue_update"');
  });

  it('clears currentParentBatchId on agent_end so the next turn starts fresh', () => {
    const source = pluginSource();
    // agent_end must reset the in-flight marker. Previously a redundant
    // `turnInFlight = false` toggle did this — now the batch id field
    // doubles as the in-flight signal.
    expect(source).toMatch(/agent_end[\s\S]*currentParentBatchId\s*=\s*null/);
  });

  it('does not declare a redundant turnInFlight flag', () => {
    // Regression guard: the previous implementation carried a `turnInFlight`
    // boolean that was strictly derivable from `currentParentBatchId !== null`.
    // The variable is gone — the batch id is the only in-flight signal.
    const source = pluginSource();
    expect(source).not.toMatch(/\blet\s+turnInFlight\b/);
  });

  it('mycoPostUserPrompt forwards kind + parent_prompt_batch_id', () => {
    const source = pluginSource();
    expect(source).toContain('kind');
    expect(source).toContain('parentPromptBatchId');
    expect(source).toContain('parent_prompt_batch_id');
  });

  it('uses BATCH_KIND constants instead of raw "steering"/"initial" strings', () => {
    const source = pluginSource();
    // The shared snippet defines BATCH_KIND; the plugin must route through
    // those constants to avoid typoed kinds falling through unchanged.
    expect(source).toContain('BATCH_KIND.INITIAL');
    expect(source).toContain('BATCH_KIND.STEERING');
  });

  it('does not duplicate digest fallback logic — the in-process myco_cortex tool owns it', () => {
    // After the /api/mcp/* retirement, all Pi tool wrappers delegate to the
    // Myco binary's `tool call`. The cortex tier-fallback logic now lives in the
    // in-daemon myco_cortex tool, so Pi's plugin should not contain its own
    // tiers/Array.isArray reasoning.
    const source = pluginSource();
    expect(source).not.toMatch(/Array\.isArray\([\s\S]*tiers/);
  });

  it('postEventWithBuffer returns the daemon response and detects ignored drops', () => {
    const source = pluginSource();
    expect(source).toContain('return result.data');
    expect(source).toContain('isIgnoredResponse');
  });

  it('mycoPostStop buffers the stop event on daemon failure', () => {
    const source = pluginSource();
    expect(source).toMatch(/mycoPostStop[\s\S]*bufferEvent/);
    expect(source).toContain('type: "stop" as const');
  });

  it('registers the custom /exit command', () => {
    const source = pluginSource();
    expect(source).toContain('pi.registerCommand("exit"');
    expect(source).toContain('ctx.shutdown()');
  });

  it('mirrors the canonical local MCP tool surface by name', () => {
    // The MCP surface is intentionally limited to read/editorial tools
    // for symbionts — no operator/admin tools. Pi (handheld terminal-
    // agent template) mirrors that canonical surface 1:1.
    // See docs/architecture/actors-and-boundaries.md for the boundary.
    const source = pluginSource();
    for (const tool of TOOL_DEFINITIONS) {
      expect(source).toContain(`name: "${tool.name}"`);
    }
  });

  it('does not expose the legacy non-MCP myco_observe alias', () => {
    const source = pluginSource();
    expect(source).not.toContain('name: "myco_observe"');
  });

  it('routes all tool calls through the Myco binary; capture/lifecycle stays on HTTP', () => {
    const source = pluginSource();
    // Tool calls (myco_cortex, myco_spores, etc.) run the self-contained Myco
    // binary directly (`<binary> tool call …`, no node/launcher.cjs) — the
    // standard non-MCP-symbiont pattern after the /api/mcp/* retirement. Each
    // tool wrapper delegates via execMycoTool.
    expect(source).toContain('execMycoTool(directory, "myco_cortex"');
    expect(source).toContain('execMycoTool(directory, "myco_spores"');
    expect(source).toContain('execMycoTool(directory, "myco_plans"');
    expect(source).toContain('execMycoTool(directory, "myco_sessions"');
    expect(source).toContain('execMycoTool(directory, "myco_search"');
    // Capture/lifecycle/context endpoints remain HTTP — they are universal
    // symbiont infrastructure (the daemon's EventBuffer + reconciliation
    // path), not tool calls. Pi must keep using them directly.
    expect(source).toContain('postJson(directory, "/context", { session_id: sessionId })');
    expect(source).toContain('postJson(directory, "/context/resume", {');
    expect(source).toContain('postJson(directory, "/sessions/register"');
    expect(source).toContain('postJson(directory, "/events"');
  });

  it('dispatches Myco tools via the direct binary (runtime.command pin), never node + launcher.cjs or the retired project-local launcher', () => {
    // Launcher unification: tool dispatch invokes the self-contained Myco binary
    // directly — resolved via the runtime.command pin (project-scope upward walk,
    // then machine pin, then bare `myco` on PATH) — with no `node` and no
    // `launcher.cjs`. This is the form that works on a native, node-absent
    // install and matches every other symbiont's hook/MCP transport. With
    // `cwd: directory` carrying per-project tenancy.
    const source = pluginSource();
    // The retired project-local launcher path must not reappear.
    expect(source).not.toContain('.agents/myco-run.cjs');
    expect(source).not.toContain('.agents", "myco-run.cjs');
    // Dispatch must NOT shell out to node, nor resolve the retired global launcher.cjs.
    expect(source).not.toMatch(/execFileP\(\s*"node"/);
    expect(source).not.toMatch(/join\(resolveMycoHome\(\),\s*"launcher\.cjs"\)/);
    // Dispatch resolves the binary via the runtime.command pin and execs it directly.
    expect(source).toContain('runtime.command');
    expect(source).toMatch(/const binary = resolveMycoBinary\(directory\)/);
    expect(source).toMatch(/execFileP\(\s*binary,\s*\[\s*"tool",\s*"call"/);
    // Tenancy still flows via the child process cwd.
    expect(source).toMatch(/cwd: directory/);
  });

  describe('per-prompt context injection (before_agent_start)', () => {
    // The handler block runs from the before_agent_start subscription to the
    // next subscription (`input`). Pinning against this slice keeps the
    // assertions scoped to the handler rather than the whole file.
    function beforeAgentStartBlock(): string {
      const source = pluginSource();
      const start = source.indexOf('pi.on("before_agent_start"');
      const end = source.indexOf('pi.on("input"');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return source.slice(start, end);
    }

    it('fetches per-prompt context via POST /context/prompt', () => {
      expect(beforeAgentStartBlock()).toContain('postJson(currentCwd, "/context/prompt"');
    });

    it('captures the prompt BEFORE fetching context — the daemon attaches the injection record to the batch the /events POST creates', () => {
      // Sequential ordering, not Promise.all: parallelizing would attach the
      // injection record to the previous turn's batch.
      expect(beforeAgentStartBlock()).toMatch(/mycoPostUserPrompt\([\s\S]*?"\/context\/prompt"/);
    });

    it('delivers context via the message result field (persistent custom message), not a systemPrompt mutation', () => {
      const block = beforeAgentStartBlock();
      expect(block).toMatch(/return\s*\{\s*message:\s*\{\s*customType:\s*"myco-prompt-context"/);
      // No systemPrompt field in the result — pi resets systemPrompt every
      // turn, which would evict the injected spores from history.
      expect(block).not.toMatch(/systemPrompt\s*:/);
    });

    it('does NOT call the session /context endpoint from before_agent_start — that injection belongs to session_start', () => {
      // `"/context"` with the closing quote distinguishes the session
      // endpoint from `"/context/prompt"`.
      expect(beforeAgentStartBlock()).not.toMatch(/postJson\([^)]*"\/context"/);
    });
  });

  it('does not call any /api/mcp/* endpoint (those routes were deleted)', () => {
    // Match actual HTTP call sites, not doc-comment mentions of the retired
    // surface. The plugin's header comment narrates the migration and is
    // expected to reference `/api/mcp/*` historically.
    const source = pluginSource();
    expect(source).not.toMatch(/(?:postJson|getJson|deleteJson|fetch)\([^)]*["']\/api\/mcp\//);
  });
});
