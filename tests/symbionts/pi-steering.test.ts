import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'bun:test';
import { TOOL_DEFINITIONS, COLLECTIVE_TOOL_DEFINITIONS } from '@myco/tools/definitions.js';

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

  it('trusts the /api/digest response shape without defensive Array.isArray gating', () => {
    // The daemon owns the digest contract and always returns `tiers: []`.
    // Defensive `!Array.isArray(...)` branching on our own response just
    // masks real bugs, so it was dropped.
    const source = pluginSource();
    expect(source).not.toMatch(/!Array\.isArray\([\s\S]*tiers/);
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

  it('mirrors the local MCP tool surface by name', () => {
    const source = pluginSource();
    for (const tool of TOOL_DEFINITIONS) {
      expect(source).toContain(`name: "${tool.name}"`);
    }
  });

  it('includes the collective tool names for parity when Collective is connected', () => {
    const source = pluginSource();
    for (const tool of COLLECTIVE_TOOL_DEFINITIONS) {
      expect(source).toContain(`name: "${tool.name}"`);
    }
  });

  it('does not expose the legacy non-MCP myco_observe alias', () => {
    const source = pluginSource();
    expect(source).not.toContain('name: "myco_observe"');
  });

  it('uses /api/digest for myco_cortex digest and /context for session-start injection', () => {
    const source = pluginSource();
    expect(source).toContain('getJson(directory, "/api/digest")');
    expect(source).toContain('postJson(directory, "/context", { session_id: sessionId })');
    expect(source).toContain('postJson(directory, "/context/resume", {');
  });
});
