/** Compiled smoke fixture: production update/provision/handoff operations with local releases and a service-manager stub. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { run as update } from '@myco/cli/update.js';
import { run as runner } from '@myco/cli/runner.js';
import { runProvision } from '@myco/cli/member.js';
import { setPluginVersion } from '@myco/version.js';
import { writeInstallMarker } from '@myco/install/managed-binary.js';
import { resolveMycoBinaryUpdateRefs } from '@myco/upgrade/release-resolver.js';
import { resolveMycoPackageCheck } from '@myco/upgrade/checker.js';
import { resolveTargetTriple, type GitHubRelease } from '@myco/upgrade/release-assets.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { recordProvision } from '@myco/symbionts/member-provision-record.js';
import { publishRunnerRecord, withRunnerLock } from '@myco/runner/runner-registry.js';
import { installWorkerService } from '@myco/runner/service.js';
import { recordingPlatform } from '../../helpers/fake-service-manager.js';
import { runRunnerUpdateHelper } from '@myco/runner/update-helper.js';
import { withRunnerUpdateState, runnerUpdateStatePath, readRunnerUpdateState, strictRunnerReleaseProbe } from '@myco/runner/update.js';
import { holdWorkerInstance } from '@myco/runner/instance.js';

declare const FIXTURE_VERSION: string;
setPluginVersion(FIXTURE_VERSION);
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(FIXTURE_VERSION); process.exit(0); }
const home = process.env.MYCO_HOME!;
const binary = path.join(home, 'bin', 'myco');
const serverUrl = 'https://compiled-update.invalid';
const service = recordingPlatform();
const stateFile = path.join(home, 'fixture-service-state.json');
if (fs.existsSync(stateFile)) {
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  saved.loaded.forEach((label: string) => service.loaded.add(label));
  saved.running.forEach((label: string) => service.running.add(label));
}
const releases = (): GitHubRelease[] => JSON.parse(fs.readFileSync(process.env.MYCO_FIXTURE_RELEASES!, 'utf8'));
const releaseFetch: typeof fetch = Object.assign(async () => Response.json(releases()), { preconnect: () => {} });
const stageDeps = {
  download: async (url: string, dest: string) => fs.copyFileSync(new URL(url), dest),
  computeSha256: async (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
};
const runnerDeps = {
  mycoHome: home, home: process.env.HOME!, binaryPath: binary, version: FIXTURE_VERSION,
  platform: process.platform, runner: service.runner, lockDir: path.join(home, 'locks'), ownDeploymentUrls: async () => [],
  update: { fetch: releaseFetch, stageDeps,
    installGuardian: () => ({ unitFile: 'fixture', loaded: true, running: true, changed: true }), removeGuardian: () => {},
  },
};
if (args[0] === 'prepare') {
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.copyFileSync(process.execPath, binary); fs.chmodSync(binary, 0o755);
  writeInstallMarker(home, { channel: 'alpha', source: 'curl', bin: binary });
  if (args[1] !== 'runner') {
    writeDeploymentMembership({ serverUrl, token: 'm'.repeat(43), machineId: 'fixture-member', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
    recordDefaultDeployment(serverUrl, { mycoHome: home });
    recordProvision(home, { version: FIXTURE_VERSION, serverUrl, agents: [] });
  }
  if (args[1] !== 'member') {
    await withRunnerLock(serverUrl, lock => publishRunnerRecord(lock, {
      version: 1, serverUrl, deploymentId: 'fixture-deployment', runnerId: 'fixture-runner', name: 'fixture', token: `mycorun_${'r'.repeat(43)}`,
    }), home);
    installWorkerService({ ...runnerDeps, serverUrl, executor: 'runner' }, [], { runner: service.runner });
  }
} else if (args[0] === 'member') {
  if (!runProvision(args.slice(2), { mycoHome: home, cwd: process.cwd(), packageRoot: process.env.MYCO_FIXTURE_PACKAGE_ROOT! })) process.exitCode = 1;
} else if (args[0] === 'finish-handoff') {
  const tx = readRunnerUpdateState(home).transaction!;
  let running = true;
  await runRunnerUpdateHelper(runnerUpdateStatePath(home), {
    alive: pid => pid !== tx.ownerPid, stopped: () => !running,
    stop: () => { running = false; },
    start: () => {
      running = true;
      withRunnerUpdateState(home, state => { state.transaction!.phase = 'healthy'; });
      return { unitFile: 'fixture', loaded: true, running: true, changed: true };
    },
    probe: (file, version) => strictRunnerReleaseProbe(file, version, process.platform),
    removeGuardian: () => {}, prune: () => {},
  });
} else if (args[0] === 'update' || args[0] === 'upgrade') {
  const held = process.env.MYCO_FIXTURE_BUSY === '1'
    ? holdWorkerInstance(path.join(home, 'locks'), [serverUrl], 'fixture-deployment') : null;
  try {
    await update(args.slice(1), {
      home, currentVersion: FIXTURE_VERSION,
      resolveRefs: channel => resolveMycoBinaryUpdateRefs(channel, { fetchReleases: async () => releases(), targetTriple: resolveTargetTriple }, FIXTURE_VERSION),
      checkFn: (current, channel, installed) => resolveMycoPackageCheck(current, channel, installed, releaseFetch),
      stageDeps,
      runRunner: (rest, deps) => runner(rest, { ...runnerDeps, ...deps }),
    });
  } finally { if (held?.held) held.release(); }
} else throw new Error('unknown fixture command');
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify({ loaded: [...service.loaded], running: [...service.running], commands: service.commands }));
