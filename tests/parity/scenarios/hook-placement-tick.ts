import { hookPlacement } from './hook-placement.ts';
import { tick } from './tick.ts';
import type { ParityScenario } from '../harness.ts';

export const hookPlacementTick: ParityScenario = {
  name: 'hook placement then wake: retention excludes fresh context answers',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    await hookPlacement.run(target);
    await tick.run(target);
  },
};
