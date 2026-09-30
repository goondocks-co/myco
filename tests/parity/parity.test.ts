import { repositories } from './scenarios/repositories.ts';
import { canopy } from './scenarios/canopy.ts';
import { skillCandidates } from './scenarios/skill-candidates.ts';
import { afterAll, beforeAll, describe, it, test } from 'bun:test';
import { runScenario, type ParityScenario, type ParityTarget } from './harness.ts';
import { bootSelfhosted } from './targets/selfhosted.ts';
import { bootCloudflare } from './targets/cloudflare.ts';
import { backupRestore, restoreContinuation } from './scenarios/backup-restore.ts';
import { sessionsTitling } from './scenarios/sessions-titling.ts';
import { sessionTurns } from './scenarios/session-turns.ts';
import { plans } from './scenarios/plans.ts';
import { plansAtScale } from './scenarios/plans-at-scale.ts';
import { spores } from './scenarios/spores.ts';
import { recall } from './scenarios/recall.ts';
import { tick } from './scenarios/tick.ts';
import { importParity } from './scenarios/import.ts';
import { legacyImportParity } from './scenarios/legacy-import.ts';
import { dispatchQueue } from './scenarios/dispatch-queue.ts';
import { scheduledTasks } from './scenarios/scheduled-tasks.ts';
import { cortex } from './scenarios/cortex.ts';
import { replacedRun } from './scenarios/replaced-run.ts';
import { search } from './scenarios/search.ts';
import { grants } from './scenarios/grants.ts';
import { workerWire } from './scenarios/worker-wire.ts';
import { codexRecording } from './scenarios/codex-recording.ts';
import { transcriptReread } from './scenarios/transcript-reread.ts';
import { transcriptBacklog } from './scenarios/transcript-backlog.ts';
import { toolBlobRetention } from './scenarios/tool-blob-retention.ts';
import { titlingBackfill } from './scenarios/titling-backfill.ts';
import { sessionEnd } from './scenarios/session-end.ts';
import { projectCounts } from './scenarios/project-counts.ts';
import { objectLifecycle } from './scenarios/object-lifecycle.ts';
import { tokenRefresh } from './scenarios/token-refresh.ts';
import { captureVolume } from './scenarios/capture-volume.ts';
import { memberSettings } from './scenarios/member-settings.ts';
import { machineSettings } from './scenarios/machine-settings.ts';
import { sessionAuthority } from './scenarios/session-authority.ts';
import { today } from './scenarios/today.ts';
import { runReads } from './scenarios/run-reads.ts';
import { harnessCredentialSlots } from './scenarios/harness-credential-slots.ts';
import { capabilityHold } from './scenarios/capability-hold.ts';
import { joinIdentityClaimed } from './scenarios/join-identity-claimed.ts';
import { memberStatus } from './scenarios/member-status.ts';
import { githubLink } from './scenarios/github-link.ts';
import { embeddingRevisions } from './scenarios/embedding-revisions.ts';
import { recallGold } from './scenarios/recall-gold.ts';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import { parseShard, selectShard } from '../../scripts/test-shards.mjs';
import durations from '../../scripts/test-durations.json';
import { writeFileSync } from 'node:fs';

const scenarios = [restoreContinuation, repositories, canopy, skillCandidates, sessionsTitling, sessionTurns, plans, plansAtScale, spores, recall, backupRestore, tick, dispatchQueue, scheduledTasks, cortex, replacedRun, search, grants, importParity, legacyImportParity, workerWire, codexRecording, transcriptReread, transcriptBacklog, toolBlobRetention, titlingBackfill, sessionEnd, projectCounts, objectLifecycle, tokenRefresh, captureVolume, memberSettings, machineSettings, sessionAuthority, harnessCredentialSlots, capabilityHold, joinIdentityClaimed, memberStatus, embeddingRevisions, githubLink, today, runReads, recallGold];
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
    // A self-hosted scenario that queries vectors loads sqlite-vec, which needs an extension-enabled SQLite registered
    // before the first connection in this process opens; a no-op wherever the runtime's own library already loads
    // extensions. A host that has none fails only the scenarios that need one, and says why.
    let sqliteVecRefusal: string | null = null;
    try { configureSqliteLibrary(); } catch (error) { sqliteVecRefusal = error instanceof Error ? error.message : String(error); }
    const boots = [
      { name: 'selfhosted' as const, boot: (_scenario?: ParityScenario) => bootSelfhosted() },
      { name: 'cloudflare' as const, boot: (scenario?: ParityScenario) => bootCloudflare(scenario?.dedicated?.cloudflare ?? {}) },
    ];
    const shared = selected.filter((scenario) => scenario.dedicated === undefined);
    const dedicated = selected.filter((scenario) => scenario.dedicated !== undefined);
    for (const { name, boot } of boots) {
      if (shared.length > 0) {
        describe(`[${name}]`, () => {
          let target: ParityTarget | null = null;
          beforeAll(async () => {
            target = await boot();
          }, 240_000);
          afterAll(async () => {
            await target?.stop();
          });
          for (const scenario of shared) {
            it(scenario.name, async () => {
              if (target === null) throw new Error(`${name} target never booted`);
              await runScenario(target, scenario);
            }, 180_000);
          }
        });
      }
      // Each dedicated scenario boots its own target, so whatever it binds or configures reaches no other scenario.
      for (const scenario of dedicated) {
        describe(`[${name}] ${scenario.name}`, () => {
          let target: ParityTarget | null = null;
          beforeAll(async () => {
            target = await boot(scenario);
          }, 240_000);
          afterAll(async () => {
            await target?.stop();
          });
          it(scenario.name, async () => {
            if (name === 'selfhosted' && scenario.dedicated!.sqliteVec === true && sqliteVecRefusal !== null) {
              throw new Error(`this scenario needs sqlite-vec on the self-hosted target, which this host cannot load: ${sqliteVecRefusal}`);
            }
            if (target === null) throw new Error(`${name} target never booted`);
            await runScenario(target, scenario);
          }, scenario.dedicated!.timeoutMs);
        });
      }
    }
  }
}
