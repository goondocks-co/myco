import { deviceLoginFlow, deviceAdmission, deviceForeignLineageHold } from './scenarios/device-login.ts';
import { runnerIdentity, runnerFleet } from './scenarios/runner-identity.ts';
import { fleetReadBudget } from './scenarios/fleet-read-budget.ts';
import { workerWriteCompletion } from './scenarios/worker-write-completion.ts';
import { liveActorWrites } from './scenarios/live-actor-writes.ts';
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
import { transcriptRepairPriority, transcriptLiveService } from './scenarios/transcript-repair-priority.ts';
import { transcriptBacklog } from './scenarios/transcript-backlog.ts';
import { toolBlobRetention } from './scenarios/tool-blob-retention.ts';
import { titlingBackfill } from './scenarios/titling-backfill.ts';
import { titlingIdleRefresh } from './scenarios/titling-idle-refresh.ts';
import { sessionEnd } from './scenarios/session-end.ts';
import { projectCounts } from './scenarios/project-counts.ts';
import { objectLifecycle } from './scenarios/object-lifecycle.ts';
import { tokenRefresh } from './scenarios/token-refresh.ts';
import { captureVolume } from './scenarios/capture-volume.ts';
import { memberSettings } from './scenarios/member-settings.ts';
import { machineSettings } from './scenarios/machine-settings.ts';
import { workingNow } from './scenarios/working-now.ts';
import { uncaptured } from './scenarios/uncaptured.ts';
import { machines } from './scenarios/machines.ts';
import { sessionAuthority } from './scenarios/session-authority.ts';
import { today } from './scenarios/today.ts';
import { runReads } from './scenarios/run-reads.ts';
import { memberDispatch } from './scenarios/member-dispatch.ts';
import { freshOwnerLink, interruptedRestoreOwner, ownerLifecycle, restoredAuditAuthority } from './scenarios/owner-lifecycle.ts';
import { restoreAuthorityAdmission, stopAfterDemotion } from './scenarios/owner-review-corrections.ts';
import { harnessCredentialSlots } from './scenarios/harness-credential-slots.ts';
import { capabilityHold } from './scenarios/capability-hold.ts';
import { joinIdentityClaimed } from './scenarios/join-identity-claimed.ts';
import { memberStatus } from './scenarios/member-status.ts';
import { githubLink } from './scenarios/github-link.ts';
import { embeddingRevisions } from './scenarios/embedding-revisions.ts';
import { recallGold } from './scenarios/recall-gold.ts';
import { embeddingSwitch } from './scenarios/embedding-switch.ts';
import { modelCatalogs } from './scenarios/model-catalogs.ts';
import { twoDeploymentIsolation } from './scenarios/two-deployment-isolation.ts';
import { rawPrivacy } from './scenarios/raw-privacy.ts';
import { rawBackfillParity } from './scenarios/raw-backfill.ts';
import { rawClaimsParity } from './scenarios/raw-claims.ts';
import { storageCleanupParity } from './scenarios/storage-cleanup.ts';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import { PARITY_PLAN_PREFIX, parseShard, selectShard } from '../../scripts/test-shards.mjs';
import durations from '../../scripts/test-durations.json';

const scenarios = [deviceLoginFlow, deviceAdmission, deviceForeignLineageHold, runnerIdentity, runnerFleet, fleetReadBudget, twoDeploymentIsolation, workerWriteCompletion, liveActorWrites, rawClaimsParity, rawBackfillParity, rawPrivacy, storageCleanupParity, restoreContinuation, repositories, canopy, skillCandidates, sessionsTitling, sessionTurns, plans, plansAtScale, spores, recall, backupRestore, tick, dispatchQueue, scheduledTasks, cortex, replacedRun, search, grants, importParity, legacyImportParity, workerWire, codexRecording, transcriptReread, transcriptBacklog, transcriptRepairPriority, transcriptLiveService, toolBlobRetention, titlingBackfill, titlingIdleRefresh, sessionEnd, projectCounts, objectLifecycle, tokenRefresh, captureVolume, memberSettings, machineSettings, workingNow, uncaptured, machines, sessionAuthority, harnessCredentialSlots, capabilityHold, joinIdentityClaimed, memberStatus, embeddingRevisions, githubLink, ownerLifecycle, freshOwnerLink, interruptedRestoreOwner, restoredAuditAuthority, restoreAuthorityAdmission, stopAfterDemotion, today, runReads, memberDispatch, recallGold, embeddingSwitch, modelCatalogs];
const DEFAULT_SCENARIO_DURATION_MS = 15_000;

if (!process.env.MYCO_PARITY) {
  test.skip('parity scenarios (run via npm run test:parity)', () => {});
} else {
  const weights: Record<string, number> = durations.parity;
  const selected = selectShard(scenarios, parseShard(process.env.MYCO_PARITY_SHARD), (scenario) => weights[scenario.name] ?? DEFAULT_SCENARIO_DURATION_MS);
  if (process.env.MYCO_PARITY_PLAN === '1') {
    console.log(PARITY_PLAN_PREFIX + JSON.stringify(selected.map((scenario) => scenario.name)));
    test.skip('parity shard manifest', () => {});
  } else {
    // A self-hosted scenario that queries vectors loads sqlite-vec, which needs an extension-enabled SQLite registered
    // before the first connection in this process opens; a no-op wherever the runtime's own library already loads
    // extensions. A host that has none fails only the scenarios that need one, and says why.
    let sqliteVecRefusal: string | null = null;
    try { configureSqliteLibrary(); } catch (error) { sqliteVecRefusal = error instanceof Error ? error.message : String(error); }
    const boots = [
      { name: 'selfhosted' as const, boot: (scenario?: ParityScenario) => bootSelfhosted({ stopRace: scenario?.dedicated?.stopRace === true }) },
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
          let peer: ParityTarget | null = null;
          beforeAll(async () => {
            target = await boot(scenario);
            if (scenario.paired === true) peer = await boot(scenario);
          }, scenario.paired === true ? 360_000 : 240_000);
          afterAll(async () => {
            try { await peer?.stop(); }
            finally { await target?.stop(); }
          });
          it(scenario.name, async () => {
            if (name === 'selfhosted' && scenario.dedicated!.sqliteVec === true && sqliteVecRefusal !== null) {
              throw new Error(`this scenario needs sqlite-vec on the self-hosted target, which this host cannot load: ${sqliteVecRefusal}`);
            }
            if (target === null) throw new Error(`${name} target never booted`);
            await runScenario(target, scenario, peer ?? undefined);
          }, scenario.dedicated!.timeoutMs);
        });
      }
    }
  }
}
