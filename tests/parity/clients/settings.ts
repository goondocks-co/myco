import { expect } from 'bun:test';
import { owner, putSetting, resetSetting, type RouteTarget } from './requests.ts';

/** Restores each shared Deployment leaf to the configuration read before the scenario. */
export async function withSettings(target: RouteTarget, settings: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
  const snapshot = await owner(target, '/api/settings');
  expect(snapshot.status).toBe(200);
  const before = snapshot.body.leaves;
  try {
    for (const [leaf, value] of Object.entries(settings)) expect((await putSetting(target, leaf, value)).status).toBe(200);
    await run();
  } finally {
    const failures: unknown[] = [];
    for (const leaf of Object.keys(settings)) {
      try {
        const previous = before.find((row: any) => row.leaf === leaf);
        expect((await (previous?.configured ? putSetting(target, leaf, previous.value) : resetSetting(target, leaf))).status).toBe(200);
      } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'settings restoration failed');
  }
}
