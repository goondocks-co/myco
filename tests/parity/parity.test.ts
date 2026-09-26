import { repositories } from './scenarios/repositories.ts';
import { canopy } from './scenarios/canopy.ts';
import { skillCandidates } from './scenarios/skill-candidates.ts';
import { afterAll, beforeAll, describe, it, test } from 'bun:test';
import { runScenario, type ParityTarget } from './harness.ts';
import { bootSelfhosted } from './targets/selfhosted.ts';
import { bootCloudflare } from './targets/cloudflare.ts';
import { backupRestore, restoreContinuation } from './scenarios/backup-restore.ts';
import { sessionsTitling } from './scenarios/sessions-titling.ts';
import { sessionTurns } from './scenarios/session-turns.ts';
import { plans } from './scenarios/plans.ts';
import { spores } from './scenarios/spores.ts';
import { recall } from './scenarios/recall.ts';
import { tick } from './scenarios/tick.ts';
import { importParity } from './scenarios/import.ts';
import { dispatchQueue } from './scenarios/dispatch-queue.ts';
import { scheduledTasks } from './scenarios/scheduled-tasks.ts';
import { cortex } from './scenarios/cortex.ts';
import { replacedRun } from './scenarios/replaced-run.ts';
import { search } from './scenarios/search.ts';
import { grants } from './scenarios/grants.ts';
import { workerWire } from './scenarios/worker-wire.ts';
import { codexRecording } from './scenarios/codex-recording.ts';
import { toolBlobRetention } from './scenarios/tool-blob-retention.ts';
import { titlingBackfill } from './scenarios/titling-backfill.ts';
import { sessionEnd } from './scenarios/session-end.ts';
import { projectCounts } from './scenarios/project-counts.ts';
import { objectLifecycle } from './scenarios/object-lifecycle.ts';
import { tokenRefresh } from './scenarios/token-refresh.ts';
import { memberSettings } from './scenarios/member-settings.ts';
import { memberStatus } from './scenarios/member-status.ts';
import { parseShard, selectShard } from '../../scripts/test-shards.mjs';
import durations from '../../scripts/test-durations.json';
import { writeFileSync } from 'node:fs';

const scenarios = [restoreContinuation, repositories, canopy, skillCandidates, sessionsTitling, sessionTurns, plans, spores, recall, backupRestore, tick, dispatchQueue, scheduledTasks, cortex, replacedRun, search, grants, importParity, workerWire, codexRecording, toolBlobRetention, titlingBackfill, sessionEnd, projectCounts, objectLifecycle, tokenRefresh, memberSettings, memberStatus];
const DEFAULT_SCENARIO_DURATION_MS = 15_000;

if (!process.env.MYCO_PARITY) {
  test.skip('parity scenarios (run via npm run test:parity)', () => {});
} else {
  const weights: Record<string, number> = durations.parity;
  const selected = selectShard(scenarios, parseShard(process.env.MYCO_PARITY_SHARD), (scenario) => weights[scenario.name] ?? DEFAULT_SCENARIO_DURATION_MS);
  if (process.env.MYCO_PARITY_PLAN_FILE) {
    writeFileSync(process.env.MYCO_PARITY_PLAN_FILE, JSON.stringify(selected.map((scenario) => scenario.name)));
    test.skip('parity shard manifest', () => {});
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
        for (const scenario of selected) {
          it(scenario.name, async () => {
            if (target === null) throw new Error(`${name} target never booted`);
            await runScenario(target, scenario);
          }, 180_000);
        }
      });
    }
  }
}
