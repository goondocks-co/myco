/**
 * Type-level + structural test confirming HarnessToolSurface accepts
 * optional hooks/hookContext fields without breaking any existing
 * required field.
 */

import { describe, it, expect } from 'bun:test';
import type { HarnessToolSurface, HarnessExecuteInput, HarnessScopeSetup } from '@myco/agent/harness/types.js';
import type { HarnessHooks, HarnessHookContext } from '@myco/agent/harness/hooks.js';

describe('HarnessToolSurface hooks fields', () => {
  it('HarnessToolSurface compiles with hooks and hookContext set', () => {
    const hookContext: HarnessHookContext = { runId: 'run-1', agentId: 'agent-1', harnessId: 'claude-sdk' };
    const hooks: HarnessHooks = { preToolUse: () => {} };
    const surface: HarnessToolSurface = {
      agentId: 'agent-1',
      runId: 'run-1',
      hooks,
      hookContext,
    };
    expect(surface.hooks).toBe(hooks);
    expect(surface.hookContext).toBe(hookContext);
  });

  it('HarnessToolSurface still compiles with NO hooks fields set (backward compat)', () => {
    const surface: HarnessToolSurface = { agentId: 'agent-1', runId: 'run-1' };
    expect(surface.hooks).toBeUndefined();
    expect(surface.hookContext).toBeUndefined();
  });

  it('HarnessExecuteInput and HarnessScopeSetup compile with an optional hooks field', () => {
    const hooks: HarnessHooks = { phaseStart: () => {} };
    const executeInput: HarnessExecuteInput = {
      prompt: 'do the thing',
      model: 'claude-sonnet-4-6',
      toolSurface: { agentId: 'agent-1', runId: 'run-1' },
      hooks,
    };
    expect(executeInput.hooks).toBe(hooks);

    const scopeSetup: HarnessScopeSetup = {
      model: 'claude-sonnet-4-6',
      toolSurface: { agentId: 'agent-1', runId: 'run-1' },
      hooks,
    };
    expect(scopeSetup.hooks).toBe(hooks);
  });
});
