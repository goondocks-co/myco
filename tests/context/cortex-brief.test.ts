import { describe, it, expect } from 'vitest';
import { buildRetrievalGuidanceLines, RETRIEVAL_GUIDANCE } from '@myco/context/cortex-brief.js';

describe('buildRetrievalGuidanceLines', () => {
  it('does not encode myco_skills guidance into Cortex instructions', () => {
    const lines = buildRetrievalGuidanceLines({
      teamEnabled: false,
      collectiveConnected: false,
      collectiveCapabilities: [],
    });

    expect(lines.join('\n')).toContain('`myco_context`');
    expect(lines.join('\n')).toContain('`myco_search`');
    expect(lines.join('\n')).toContain('`myco_save_plan`');
    expect(lines.join('\n')).not.toContain('`myco_skills`');
  });

  it('filters team and collective guidance by runtime capabilities', () => {
    const lines = buildRetrievalGuidanceLines({
      teamEnabled: false,
      collectiveConnected: false,
      collectiveCapabilities: [],
    });

    expect(lines.join('\n')).not.toContain('`myco_team`');
    expect(lines.join('\n')).not.toContain('`collective_search`');
  });
});

describe('RETRIEVAL_GUIDANCE', () => {
  it('orders Cortex-enabled tools by priority', () => {
    expect(RETRIEVAL_GUIDANCE.map((entry) => entry.tool).slice(0, 3)).toEqual([
      'myco_context',
      'myco_search',
      'myco_recall',
    ]);
  });

  // Anti-drift for Bundle D (pre-0.21.0 MCP parity).
  // If someone removes one of these tools from TOOL_DEFINITIONS or strips
  // its `cortex` entry, the brief would silently stop advertising the new
  // parity surfaces and agents would lose the session-start guidance.
  it('includes the Bundle D must-ship tools so the Cortex brief advertises them', () => {
    const names = RETRIEVAL_GUIDANCE.map((entry) => entry.tool);
    expect(names).toContain('myco_cortex');
    expect(names).toContain('myco_runs');
    // myco_plans has always been in the brief, but Bundle D extended its
    // schema. Keep a presence check so a future refactor can't drop it.
    expect(names).toContain('myco_plans');
  });

  it('injects Bundle D tool guidance into the brief body', () => {
    const lines = buildRetrievalGuidanceLines({
      teamEnabled: false,
      collectiveConnected: false,
      collectiveCapabilities: [],
    });
    const body = lines.join('\n');
    expect(body).toContain('`myco_cortex`');
    expect(body).toContain('`myco_runs`');
  });
});
