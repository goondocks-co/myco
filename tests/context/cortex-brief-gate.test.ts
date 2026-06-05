import { describe, it, expect } from 'bun:test';
import { buildScheduledCortexInstruction } from '../../packages/myco/src/context/cortex-brief';
import { MycoConfigSchema } from '../../packages/myco/src/config/schema';

describe('buildScheduledCortexInstruction cortex.enabled gate', () => {
  it('returns undefined when cortex.enabled is false (no regeneration)', async () => {
    const config = MycoConfigSchema.parse({ version: 3 });
    config.cortex.enabled = false;
    const result = await buildScheduledCortexInstruction(config, '/tmp/nonexistent-vault/.myco');
    expect(result).toBeUndefined();
  });
});
