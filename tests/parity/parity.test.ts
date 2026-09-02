import { afterAll, beforeAll, describe, it, test } from 'bun:test';
import type { ParityTarget } from './harness.ts';
import { bootSelfhosted } from './targets/selfhosted.ts';
import { bootCloudflare } from './targets/cloudflare.ts';
import { backupRestore } from './scenarios/backup-restore.ts';
import { sessionsTitling } from './scenarios/sessions-titling.ts';
import { sessionTurns } from './scenarios/session-turns.ts';
import { plans } from './scenarios/plans.ts';

const scenarios = [sessionsTitling, sessionTurns, plans, backupRestore];

if (!process.env.MYCO_PARITY) {
  test.skip('parity scenarios (run via npm run test:parity)', () => {});
} else {
  const boots = [
    { name: 'selfhosted' as const, boot: bootSelfhosted },
    { name: 'cloudflare' as const, boot: bootCloudflare },
  ];
  for (const { name, boot } of boots) {
    describe(`[${name}]`, () => {
      let target: ParityTarget | null = null;
      beforeAll(async () => {
        target = await boot();
      }, 240_000);
      afterAll(async () => {
        await target?.stop();
      });
      for (const scenario of scenarios) {
        it(scenario.name, async () => {
          if (target === null) throw new Error(`${name} target never booted`);
          await scenario.run(target);
        }, 180_000);
      }
    });
  }
}
