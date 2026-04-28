import { describe, it, expect } from 'bun:test';
import { executePhase } from './phase-loop.js';
import type { PhaseDefinition } from './types.js';

describe('executePhase — mode dispatch', () => {
  it('routes mode: map phases to the map-phase path', async () => {
    const phase: PhaseDefinition = {
      name: 'm', prompt: '', tools: [], maxTurns: 1, required: true,
      mode: 'map',
      perItemMaxTurns: 1,
      source: { tool: 'nonexistent', args: {}, itemsPath: 'entries' },
      item: { prompt: 'x' },
      sink: { tool: 'nonexistent', argMap: {} },
    };
    const ctx: any = {
      config: { runtime: 'claude-sdk' },
      runId: 'r', agentId: 'a',
      systemPrompt: '', vaultContext: '',
      checkpointState: { phases: {} },
    };
    const result = await executePhase({
      ctx, phasePrompt: 'p', phaseModel: 'm', phase,
      toolSurface: { agentId: 'a', runId: 'r' },
    });
    // Map path fails because the bogus source tool isn't in the registry —
    // but the failure path is the map-phase failure path, not the free-form
    // runtime.execute path. Status should be 'failed' with an error mentioning
    // the missing source tool.
    expect(result.status).toBe('failed');
    expect(result.summary).toMatch(/source tool|nonexistent/i);
  });
});
