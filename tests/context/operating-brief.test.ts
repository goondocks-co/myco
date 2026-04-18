import { describe, it, expect } from 'vitest';
import { buildRetrievalGuidanceLines } from '@myco/context/operating-brief.js';

describe('buildRetrievalGuidanceLines', () => {
  it('does not encode myco_skills guidance into Cortex instructions', () => {
    const lines = buildRetrievalGuidanceLines({
      teamEnabled: false,
      collectiveConnected: false,
      collectiveCapabilities: [],
      registeredTools: [
        'myco_context',
        'myco_search',
        'myco_recall',
        'myco_skills',
        'myco_sessions',
        'myco_plans',
        'myco_remember',
      ],
    });

    expect(lines.join('\n')).toContain('`myco_context`');
    expect(lines.join('\n')).toContain('`myco_search`');
    expect(lines.join('\n')).not.toContain('`myco_skills`');
  });
});
