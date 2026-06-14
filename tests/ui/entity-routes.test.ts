import { describe, expect, it } from 'bun:test';
import {
  agentRunSuffix,
  agentTaskSuffix,
  canopyEntrySuffix,
  sessionSuffix,
  sporeSuffix,
} from '../../packages/myco/ui/src/lib/entity-routes';

describe('entity route suffix helpers', () => {
  it('build project-relative suffixes without grove/project scope', () => {
    expect(sessionSuffix('sess 1')).toBe('/sessions/sess%201');
    expect(agentRunSuffix('run 1')).toBe('/agent/run%201');
    expect(sporeSuffix('spore 1')).toBe('/mycelium?tab=spores&spore=spore+1');
  });

  it('builds query-based suffixes for tabbed entity surfaces', () => {
    expect(agentTaskSuffix('vault evolve')).toBe('/agent?tab=tasks&task=vault+evolve');
    expect(canopyEntrySuffix('src/foo.ts')).toBe('/cortex?tab=canopy&section=entries&path=src%2Ffoo.ts');
  });
});
