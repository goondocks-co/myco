import { expect } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import type { ParityScenario } from '../harness.ts';

export const latestD1Upgrade: ParityScenario = {
  name: 'D1: latest migration upgrades seeded previous schema to expected state',
  only: 'cloudflare',
  dedicated: { cloudflare: { latestSchemaUpgrade: true }, timeoutMs: 240_000 },
  async run(target) {
    expect(await target.sql("SELECT value FROM schema_meta WHERE key = 'version'"))
      .toEqual([{ value: String(SCHEMA_STEPS.at(-1)?.version) }]);
    expect(await target.sql("SELECT event_id, producer_adapter FROM events WHERE event_id = 'upgrade_event'"))
      .toEqual([{ event_id: 'upgrade_event', producer_adapter: 'claude' }]);
    expect(await target.sql("SELECT event_type FROM agent_run_events WHERE run_id = 'upgrade_run'"))
      .toEqual([{ event_type: 'upgrade_child' }]);
  },
};
