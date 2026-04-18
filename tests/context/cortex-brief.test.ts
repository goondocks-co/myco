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
});
