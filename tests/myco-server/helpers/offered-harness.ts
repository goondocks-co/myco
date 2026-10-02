import { harnessById } from '@myco/runner/harnesses.js';
import type { OfferedHarness } from '@myco-server-worker/core/harness.js';

export function offeredHarness(id: string): OfferedHarness {
  const harness = harnessById(id);
  if (harness === null) throw new Error(`unknown fixture harness ${id}`);
  return { id, authenticated: true, profile: harness.profile };
}
