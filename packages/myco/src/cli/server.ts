/**
 * `myco server <create|status|destroy>` — argv and human output over
 * `../server/deployment.js`.
 *
 * The orchestration lives there so `myco setup` provisions through the same
 * code path rather than a second one that drifts.
 */
import {
  createDeployment,
  deploymentStatus,
  destroyDeployment,
  removeBundle,
  resolveDeploymentPaths,
  bundleContents,
  signInConfigured,
  backupDeployment,
  restoreDeployment,
  updateDeployment,
  rotateSecrets,
  adoptDeployment,
} from '../server/deployment.js';
import { CommandFailed } from '../server/runner.js';
import { ComposeFilesUnreadable, HarnessLeftStopped, RestoreLeftIncomplete, UpdateRolledBack, UpdateRollbackFailed } from '../server/deployment.js';
import { registerGitHubApp, RegistrationRefused, resolveSignInTarget } from '../server/github-app.js';
import { WranglerNotReady, deploymentRecordPath, readDeploymentRecord, writeDeploymentRecord } from '../server/cloudflare.js';
import { DeployConfigIncomplete, renderDeployConfig } from '../server/deploy-config.js';
import { cloudflareDeploymentStatus, createCloudflareDeployment, destroyCloudflareDeployment, rollbackCloudflareDeployment, updateCloudflareDeployment } from '../server/cloudflare-lifecycle.js';
import { existsSync } from 'node:fs';
import { parseFlags } from './shared.js';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { readDeploymentMembership } from '../member/registry.js';
import { runWorker } from '../runner/loop.js';
import { workerLockDir } from '../runner/instance.js';

/** What a worker waits before its first answer tells it the Deployment's own cadence. */
const WORKER_POLL_IDLE_MS = 2_000;
import {
  DEFAULT_LOCAL_RECORD,
  LocalDeploymentAbsent,
  LocalRecordUnreadable,
  createLocalDeployment,
  localDeploymentPresent,
  localDeploymentUrls,
  readLocalRecord,
  removeLocalDeployment,
  resolveLocalPaths,
  updateLocalDeployment,
  type LocalDeploymentRecord,
} from '../server/local.js';
import { keptArtifacts } from '../server/local-artifacts.js';
import { schemaMetaValue } from '@myco-server-worker/platform/bun/server-main.js';
import { carriedNative, runLocalDeployment } from '../server/local-run.js';
import { setupLocalOwner } from '../server/local-owner.js';
import { backupLocalDeployment, localRecoveryHold } from '../server/local-backup.js';
import { backupCloudflareDeployment, cloudflareRecoveryHoldOf } from '../server/cloudflare-backup.js';
import { materializeRecoveryStaging } from '../server/recovery-materialize.js';
import { abandonRecoveryHold, credentialsReport, recoveryHoldOfDestination, type RecoveryHoldOwner } from '../server/recovery-bundle.js';
import { restoreLocalDeployment } from '../server/local-recovery.js';
import { restoreCloudflareDeployment } from '../server/cloudflare-recovery.js';
import {
  ServicePathUnsupported,
  ServicePlatformUnsupported,
  defaultSpec,
  installService,
  servicePaths,
  startService,
  statusOfService,
  stopService,
  uninstallService,
} from '../server/service.js';

export const SERVER_HELP = `Usage: myco server <command>

Commands (--target local runs the Deployment from this binary; --target cloudflare selects the Worker):
  setup-owner --target local             Create the first administrator on a stopped, fresh Deployment.
                                          Prints a private, expiring GitHub account-link URL.
                                          Retry replaces a pending link; existing members are preserved.
  create --target local [--port <n>]      Provision a Deployment this machine runs itself: a data
                                          directory, generated secrets, and a migrated volume.
  run --target local                      Serve it in the foreground. This is what the service runs.
  install --target local                  Run it whenever you log in, restarting it if it stops.
  uninstall --target local                Stop it and remove the service. Its data is kept.

  create [--port <n>] [--version <tag>] [--fleet <n>] [--origin <url>]
                                          Provision and start the Deployment. --fleet sets how many
                                          runtimes may run at once (default 4); --origin is the
                                          address members reach it at when a proxy fronts it.
  create --target cloudflare --account-id <id> [--url <https://…>]
                                          Provision D1/R2/Vectorize/secrets store, install generated
                                          secrets, migrate, deploy, and write the deployment record.
                                          Needs Node and a wrangler login on this machine and nothing
                                          else: the Worker, its dashboard and its migrations all
                                          travel in this binary. --url puts it on a domain you own.
  status                                  Report what is provisioned and running.
                                          With --target cloudflare: the record and the deployed version.
  update [--version <tag>] [--no-rollback] [--no-drain] [--no-pull]
                                          Move to a new image; the container migrates on start.
                                          A failed update returns to the previous version. Waits for
                                          the tasks this Deployment is running or about to start
                                          before it recreates; work queued behind a limit waits for
                                          the next wake either way. --no-drain skips the wait; the
                                          harness is still stopped first, so live runs finish inside
                                          its stop grace before the server is touched. --no-pull
                                          recreates on the images this machine already holds, for a
                                          tag built here or loaded from a file.
  update --target cloudflare              Move the Worker to the version this binary carries. It
                                          preserves attached workers. Bounded embedding work uses
                                          persisted progress to recover from interruption.
  rollback --target cloudflare [--version <id>] [--message <text>]
                                          Return the Worker to an earlier version. Defaults to the
                                          record's last recorded one — the version a failed update
                                          left serving.
  materialize --from <staging> --to <dir>
                                          Materialize a myco-recovery/3 staging into a verified
                                          recovery artifact. Local only; reads the staging read-only.
  backup --to <dir> [--target local|cloudflare|compose]
                                          Snapshot the database and blobs. Local/Cloudflare backups
                                          resume an incomplete directory and verify every blob.
                                          Credentials require separate secure recovery storage.
                                          Local/Cloudflare backups hold every object the snapshot
                                          names against deletion until the artifact completes, so
                                          storage grows by what deletion would have freed until then.
                                          Run the same command again to resume an interrupted copy.
  recovery-hold --to <dir> [--target local|cloudflare]
                                          What the backup in <dir> holds on its source. --abandon
                                          gives that hold up, so deferred deletions are decided
                                          again; the incomplete directory can then only be replaced
                                          by a new capture. A hold never expires on its own.
  recovery-hold --token <id> --abandon [--target local|cloudflare]
                                          Give up a hold whose destination directory is gone. It
                                          releases only that operator hold, never an automatic
                                          export's.
  restore --target compose --from <dir> [--no-drain]
                                          Replace the Deployment's data with a backup. Waits for the
                                          tasks this Deployment is running or about to start before
                                          it stops. --no-drain skips the wait; the harness is still
                                          stopped first, so live runs finish inside its stop grace
                                          before the server is touched.
  restore --target local --from <dir> --secrets-from <file> --yes [--port <n>]
                                          Recover into a fresh native Deployment directory. Verify
                                          data and independent credentials before publishing it.
                                          Keeps the source; refuses an existing destination.
  restore --target cloudflare --from <dir> --secrets-from <file> --account-id <id> --yes
                                          Recover into fresh hosted resources under a fresh MYCO_HOME.
                                          Keeps the source and requires independent credentials.
                                          Verify sign-in and search readiness before cutover.
  restore --target local|cloudflare ... --new-signin
                                          Require only the original wrapping key in --secrets-from.
                                          Create a fresh session secret and configure GitHub sign-in
                                          afterward with server github-app. Keeps source sign-in intact.
  rotate [--yes]                           Replace generated secrets. Ends every signed-in session.
  adopt                                   Write a bundle for a stack this machine did not provision.
  destroy [--data] [--yes]                Stop and remove the stack, at once — it does not wait for
                                          the runs in flight. --data also removes the volume.
                                          With --target cloudflare: removes the Worker only; data stands.
  config [--out <path>] [--fleet <n>]     Render the Cloudflare deploy config from the committed
                                          configuration and this machine's deployment record.
                                          --fleet sets how many runtimes the server may start at
                                          once; the next update deploys it.
  github-app --url <https://…> [--org <name>] [--name <text>] [--target local|cloudflare|compose]
                                          Native setup requires a stopped server. Stop a foreground run
                                          with Ctrl-C, or use server uninstall to stop its service.
                                          Start it again after setup to use the new sign-in credentials.
                                          Register the dashboard's sign-in app on GitHub (one click
                                          there) and install its credentials on the Deployment.

A Deployment run from this binary needs no container runtime and no Node.
The Cloudflare target needs Node and wrangler on THIS machine, and neither on
the Deployment. The Compose bundle is ordinary Compose: everything for that
target is also runnable with \`docker compose\` from the deployment directory.`;

/** The verbs a Deployment this machine runs answers to; every other verb belongs to the hosted targets. */
const LOCAL_VERBS = new Set(['create', 'run', 'install', 'uninstall', 'status', 'update', 'destroy']);

/**
 * Whether the Deployment answers on its own address.
 *
 * A unit the platform reports as loaded says the service was accepted, not that
 * the process inside it is serving; a crash loop reports loaded on every
 * platform. The address is what a member reaches, so the address is what is
 * asked.
 */
async function reachable(record: { port: number; origin?: string }): Promise<boolean> {
  const base = record.origin ?? `http://127.0.0.1:${record.port}`;
  try {
    const answered = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(2_000) });
    return answered.ok;
  } catch {
    return false;
  }
}

/** Opens a URL in the operator's browser where one is available; failure is silent and the URL is printed anyway. */
async function openInBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => resolve());
    child.on('spawn', () => { child.unref(); resolve(); });
  });
}

/**
 * What an operator backup is holding on this Deployment, when one is. Deletions are recorded and deferred while it is
 * open, so storage grows by what they would have freed; only the backup completing, or being given up, releases it.
 */
async function reportOperatorHold(owner: RecoveryHoldOwner): Promise<void> {
  let held: Awaited<ReturnType<RecoveryHoldOwner['open']>>;
  try {
    held = await owner.open();
  } catch (error) {
    // Silence here would read as "no backup holds this Deployment", which is the one thing this must never say.
    console.log(`  Backup hold: unreadable — ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (held === null) return;
  console.log(`  Backup hold: ${held.token} since ${new Date(held.acquiredAt).toISOString()}`);
  console.log('               deletions are deferred while an operator backup holds this Deployment\'s objects');
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * The worker inside the laptop server process.
 *
 * It attaches over the loopback address the Deployment just bound, under the
 * membership this machine holds for it. A machine that holds none serves
 * without a worker and says so: the Deployment still takes work, and the queue
 * waits for a worker that can claim it.
 */
async function startLocalWorker(record: Pick<LocalDeploymentRecord, 'port' | 'origin'>): Promise<void> {
  const [serverUrl, ...fronts] = localDeploymentUrls(record);
  const mycoHome = resolveMycoHome();
  const membership = readDeploymentMembership(serverUrl!, mycoHome);
  if (membership === null) {
    console.log('No membership for this Deployment on this machine; serving without a worker. Run `myco login` to attach one.');
    return;
  }
  const stopping = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping.abort(); });
  // The Deployment serves whatever becomes of the worker, so its end is reported
  // in the same words as a machine that holds no membership at all: a refused
  // worker and an absent one leave the same queue waiting, and the operator
  // needs to be told which. An unexpected failure is reported rather than left
  // to surface as an unhandled rejection, which would say nothing about what the
  // queue is now waiting for.
  void runWorker({
    serverUrl: serverUrl!,
    token: () => readDeploymentMembership(serverUrl!, mycoHome)?.token ?? null,
    lockDir: workerLockDir(),
    deploymentUrls: [serverUrl!, ...fronts],
    runRoot: path.join(mycoHome, 'worker', 'runs'),
    pollIdleMs: WORKER_POLL_IDLE_MS,
    log: (line) => { console.log(`worker: ${line}`); },
    signal: stopping.signal,
  }).then(({ refused }) => {
    if (refused !== null) console.log(`This Deployment refused the worker on this machine (${refused}); serving without one.`);
  }).catch((error: unknown) => {
    console.log(`The worker on this machine stopped (${error instanceof Error ? error.message : String(error)}); serving without one.`);
  });
}

export async function run(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(SERVER_HELP);
    process.exit(command === undefined ? 2 : 0);
  }

  const { flags } = parseFlags(rest);

  /** Which target a lifecycle verb acts on: named, else the one this machine holds. */
  const target = (): 'cloudflare' | 'compose' | 'local' => {
    const named = flags.get('target');
    if (named === 'cloudflare' || named === 'compose' || named === 'local') return named;
    if (named !== undefined) fail(`--target must be local, cloudflare or compose, and is ${JSON.stringify(named)}`);
    const held: string[] = [];
    if (readDeploymentRecord() !== null) held.push('cloudflare');
    if (existsSync(resolveDeploymentPaths().composeFile)) held.push('compose');
    if (localDeploymentPresent()) held.push('local');
    // Two Deployments on one machine is a choice the operator makes per verb,
    // never one this guesses from what happens to be on disk.
    if (held.length > 1) fail(`this machine holds more than one Deployment (${held.join(', ')}); pass --target ${held.join(' or --target ')}`);
    return (held[0] as 'cloudflare' | 'compose' | 'local' | undefined) ?? 'compose';
  };

  /** The Cloudflare lifecycle inputs a verb needs; only a deploying verb needs a checkout. */
  const cloudflareOptions = () => {
    // A flag this target refuses by name is answered first: a refusal about a
    // missing value tells an operator to supply one, which is the wrong move
    // when the flag beside it does not apply here at all.
    if (flags.has('dir')) fail('--dir is not a flag for this target: the Worker, its dashboard and its migrations all travel in this binary, so a deploy reads no checkout.');
    if (flags.has('no-drain')) fail('--no-drain is not a flag for this target: a deploy replaces no runtime, so it waits for nothing.');
    const record = readDeploymentRecord();
    const accountId = flags.get('account-id') ?? record?.accountId;
    if (accountId === undefined || accountId === '' || accountId === 'true') fail('pass --account-id <id> (npx wrangler whoami lists the accounts this login reaches).');
    return { accountId, report: (line: string) => { console.log(line); } };
  };

  /** Where this machine's own Deployment lives, and what it is running under. */
  const localSpec = () => defaultSpec(process.execPath);


  try {
    if (command === 'setup-owner') {
      if (target() !== 'local') fail('setup-owner requires --target local');
      const result = await setupLocalOwner(resolveLocalPaths(), carriedNative());
      console.log(`First administrator: ${result.memberId}`);
      console.log('Start the Deployment, then open this private link and connect your GitHub account:');
      console.log(result.url);
      console.log(`Expires: ${new Date(result.expiresAt).toISOString()}. Keep this link private.`);
      console.log('If it expires, stop the Deployment and run setup-owner again. After linking, use Members to invite this machine.');
      return;
    }
    if (LOCAL_VERBS.has(command) && target() === 'local') {
      const paths = resolveLocalPaths();

      if (command === 'create') {
        const portFlag = flags.get('port');
        const port = portFlag === undefined ? DEFAULT_LOCAL_RECORD.port : Number(portFlag);
        if (portFlag !== undefined && (portFlag === 'true' || !Number.isInteger(port))) fail('--port needs a whole number.');
        const existing = localDeploymentPresent(paths) ? readLocalRecord(paths) : DEFAULT_LOCAL_RECORD;
        const record: LocalDeploymentRecord = { ...existing, port };
        const { generated, applied } = createLocalDeployment(record, carriedNative(), paths);
        console.log('\nDeployment ready.');
        console.log(`  Directory:  ${paths.root}`);
        console.log(`  Address:    http://127.0.0.1:${record.port}`);
        console.log(`  Schema:     ${applied === 0 ? 'already current' : `${applied} step${applied === 1 ? '' : 's'} applied`}`);
        if (generated.length > 0) console.log(`  Secrets:    generated ${generated.join(', ')}`);
        console.log('\n`myco server install` runs it whenever you log in.');
        return;
      }

      if (command === 'run') {
        const started = await runLocalDeployment(paths);
        console.log(`Deployment serving on http://127.0.0.1:${started.port}`);
        // #1151: a laptop Deployment runs a worker of its own, so a default
        // install produces spores rather than a queue nothing claims. It is an
        // ordinary client of the HTTP surface, the same one a worker on another
        // machine is, so both run identical code.
        if (flags.get('no-worker') !== 'true') await startLocalWorker({ port: started.port, origin: readLocalRecord(paths).origin });
        // The process stays up until the platform signals it; `startDeployment`
        // owns the drain.
        await new Promise<never>(() => {});
        return;
      }

      if (command === 'install') {
        const outcome = installService(localSpec());
        console.log(outcome.loaded ? 'Deployment installed and running.' : 'Service unit written, and the platform is not running it.');
        console.log(`  Unit:       ${outcome.unitFile}`);
        console.log(`  Logs:       ${servicePaths(localSpec()).outLog}`);
        if (!outcome.loaded) fail(outcome.detail ?? 'the platform did not accept the service unit');
        return;
      }

      if (command === 'uninstall') {
        const outcome = uninstallService(localSpec());
        console.log(outcome.removed ? 'Deployment service removed. Its data is kept.' : 'No service unit was installed.');
        return;
      }

      if (command === 'status') {
        if (!localDeploymentPresent(paths)) { console.log('No Deployment on this machine. `myco server create --target local` provisions one.'); return; }
        const record = readLocalRecord(paths);
        const service = statusOfService(localSpec());
        console.log('\nDeployment');
        console.log(`  Directory:  ${paths.root}`);
        console.log(`  Address:    ${record.origin ?? `http://127.0.0.1:${record.port}`}`);
        console.log(`  Service:    ${service.loaded ? 'running at login' : service.detail ?? 'not installed'}`);
        await reportOperatorHold(localRecoveryHold(paths, carriedNative()));
        console.log(`  Serving:    ${(await reachable(record)) ? 'answering on its address' : 'not answering — see ~/.myco/logs/server.log'}`);
        return;
      }

      if (command === 'update') {
        // A running Deployment serves the schema it started against, so the
        // service stops before the store moves and starts again on the
        // migrated volume.
        const spec = localSpec();
        const running = statusOfService(spec).loaded;
        if (running) {
          console.log('Stopping the Deployment before it migrates.');
          stopService(spec);
        }
        const applied = updateLocalDeployment(carriedNative(), paths);
        console.log(applied === 0 ? 'Deployment already current.' : `Deployment updated; ${applied} schema step${applied === 1 ? '' : 's'} applied.`);
        if (running) {
          const restarted = startService(spec);
          console.log(restarted.loaded ? 'Deployment running again.' : 'Deployment migrated, and the platform did not start it again.');
          if (!restarted.loaded) fail(restarted.detail ?? 'the platform did not start the service again');
        }
        return;
      }

      if (command === 'destroy') {
        const removeData = flags.has('data');
        if (removeData && !flags.has('yes')) {
          fail('--data removes the Deployment directory and everything in it. Re-run with --yes to confirm.');
        }
        const removed = uninstallService(localSpec());
        // Read while the volume is still there: what names these artifacts is the Deployment they were taken from.
        const kept = removeData
          ? keptArtifacts(paths, schemaMetaValue(paths.databasePath, 'deployment_id', carriedNative()))
          : null;
        if (removeData) removeLocalDeployment(paths);
        // The service is what this stops. A Deployment someone started in a
        // terminal with `server run` is that terminal's to end, and saying it
        // stopped would be false.
        console.log(removeData
          ? 'Deployment and its data removed.'
          : removed.removed
            ? 'Deployment service removed. Its data is kept.'
            : 'No service was installed. Its data is kept.');
        if (kept !== null) {
          console.log(`Its recovery artifacts are kept, and are what is left to restore from: ${kept.root} (${kept.complete} complete).`);
          console.log('Restore one with `myco server restore --target local --from <artifact> --secrets-from <secrets>`, or remove that directory to let them go.');
        }
        return;
      }

      fail(`\`myco server ${command}\` is not a verb for a Deployment this machine runs. Try create, run, install, uninstall, status, update or destroy.`);
    }

    if (command === 'create' && target() === 'cloudflare') {
      const urlFlag = flags.get('url');
      if (urlFlag === '' || urlFlag === 'true') fail('--url needs the address members reach this Deployment at, e.g. --url https://myco.example.com');
      const created = await createCloudflareDeployment({ ...cloudflareOptions(), ...(urlFlag === undefined ? {} : { url: urlFlag }) });
      console.log('\nCloudflare Deployment deployed.');
      if (created.createdResources.length > 0) console.log(`  Provisioned: ${created.createdResources.join(', ')}`);
      console.log(`  Version:     ${created.versionId ?? 'unknown'}`);
      // The path this home actually holds it at: a `MYCO_HOME` somewhere else
      // makes a literal a file the operator will not find.
      console.log(`  Record:      ${deploymentRecordPath()}`);
      if (created.record.url !== undefined) console.log(`  URL:         ${created.record.url}`);
      return;
    }

    if (command === 'status' && target() === 'cloudflare') {
      if (readDeploymentRecord() === null) { console.log('No Cloudflare Deployment record. myco server create --target cloudflare provisions one.'); return; }
      const status = (await cloudflareDeploymentStatus(cloudflareOptions()))!;
      console.log('\nCloudflare Deployment');
      console.log(`  Worker:     ${status.record.workerName} (account ${status.record.accountId})`);
      console.log(`  Deployed:   ${status.deployed ? status.versionId ?? 'yes' : 'no'}`);
      console.log(`  Recorded:   ${status.record.versionId ?? 'never'} at ${status.record.deployedAt}`);
      if (status.record.url !== undefined) console.log(`  URL:        ${status.record.url}`);
      await reportOperatorHold(cloudflareRecoveryHoldOf(cloudflareOptions()));
      return;
    }

    if (command === 'rollback' && target() === 'cloudflare') {
      const versionFlag = flags.get('version');
      const messageFlag = flags.get('message');
      if (versionFlag === '' || versionFlag === 'true') fail('pass --version <id> (`wrangler deployments list` names them), or omit the flag to use the record\'s last recorded version.');
      const rolled = await rollbackCloudflareDeployment({
        ...cloudflareOptions(),
        versionId: versionFlag,
        message: messageFlag !== undefined && messageFlag !== '' && messageFlag !== 'true' ? messageFlag : undefined,
      });
      console.log(`Cloudflare Deployment rolled back to version ${rolled.versionId}.`);
      return;
    }

    if (command === 'rollback') {
      fail('rollback is a --target cloudflare verb; the Compose update path rolls back on its own (--no-rollback disables it).');
    }

    if (command === 'update' && target() === 'cloudflare') {
      const updated = await updateCloudflareDeployment(cloudflareOptions());
      console.log(`Cloudflare Deployment updated to version ${updated.versionId ?? 'unknown'} (migrations first, then the Worker).`);
      return;
    }

    if (command === 'destroy' && target() === 'cloudflare') {
      if (flags.has('data')) fail('--data does not apply to the Worker target: the database, bucket, and secrets store are never removed by this command.');
      if (!flags.has('yes')) fail('destroy removes the Worker. The database, bucket, and secrets store are kept. Re-run with --yes to confirm.');
      const destroyed = await destroyCloudflareDeployment(cloudflareOptions());
      console.log(`Worker removed. Kept: ${destroyed.kept.join(', ')}.`);
      return;
    }

    if (command === 'create') {
      // The port is decided in one place, for the flag and for the bundle's own
      // `.env` alike. The flag travels as the operator typed it, so a refusal
      // names that and not what a conversion made of it.
      const port = flags.get('port');
      const fleetFlag = flags.get('fleet');
      const fleet = fleetFlag === undefined ? undefined : Number(fleetFlag);
      if (fleetFlag !== undefined && (fleetFlag === 'true' || !Number.isInteger(fleet) || fleet! < 1)) {
        fail('--fleet needs a whole number of runtimes, 1 or more.');
      }
      const originFlag = flags.get('origin');
      if (originFlag === '' || originFlag === 'true') fail('--origin needs the address members reach this Deployment at.');
      const created = await createDeployment({ port, fleet, origin: originFlag, version: flags.get('version') });
      console.log('\nDeployment started.');
      console.log(`  Directory:  ${created.root}`);
      console.log(`  Address:    http://127.0.0.1:${created.port}`);
      console.log('\nThe published port is loopback-only. Remote access is a reverse proxy in front of it.');
      return;
    }

    if (command === 'status') {
      const status = await deploymentStatus();
      if (!status.provisioned) {
        console.log('No Deployment provisioned. `myco server create` provisions one.');
        return;
      }
      const paths = resolveDeploymentPaths();
      console.log('\nDeployment');
      console.log(`  Directory:  ${paths.root}`);
      console.log(`  Bundle:     ${bundleContents(paths).join(', ')}`);
      // Every declared service, with its state: a stack whose harness exited
      // serves and runs nothing, and naming only what is up hides that.
      console.log(status.servicesError === undefined
        ? `  Services:   ${status.states.map((s) => `${s.service} (${s.state})`).join(', ')}`
        : `  Services:   could not read compose.yaml/compose.override.yaml: ${status.servicesError}`);
      console.log(`  Running:    ${status.running ? 'yes' : 'no'}`);
      // A bundle with no sign-in credential answers every owner route
      // anonymously, dispatch included, and says nothing about why.
      console.log(signInConfigured(paths)
        ? '  Sign-in:    configured'
        : '  Sign-in:    not configured — owner routes answer anonymous until `myco server github-app`');
      return;
    }

    if (command === 'update') {
      await updateDeployment({
        version: flags.get('version'),
        noRollback: flags.has('no-rollback'),
        noDrain: flags.has('no-drain'),
        noPull: flags.has('no-pull'),
      });
      console.log('Deployment updated. The container applied any migrations its volume was behind.');
      return;
    }

    if (command === 'materialize') {
      const from = flags.get('from');
      const to = flags.get('to');
      if (from === undefined || from === '' || from === 'true') fail('materialize needs --from <staging dir>.');
      if (to === undefined || to === '' || to === 'true') fail('materialize needs --to <dir>.');
      const done = await materializeRecoveryStaging({ staging: from!, destination: to!, report: (line) => { console.log(line); } });
      console.log(`Verified data artifact written to ${path.resolve(to!)} (${done.snapshot!.blobCount} blobs)`);
      console.log(credentialsReport(done.snapshot!.credentialsRequired));
      return;
    }

    if (command === 'backup') {
      const to = flags.get('to');
      if (to === undefined || to === '' || to === 'true') fail('backup needs --to <dir>.');
      const selected = target();
      if (selected !== 'compose') {
        const report = (line: string) => { console.log(line); };
        const done = selected === 'local'
          ? await backupLocalDeployment({ destination: to!, report, native: carriedNative() })
          : await backupCloudflareDeployment({ ...cloudflareOptions(), destination: to!, report });
        console.log(`Verified data artifact written to ${path.resolve(to!)} (${done.snapshot!.blobCount} blobs)`);
        console.log(credentialsReport(done.snapshot!.credentialsRequired));
        return;
      }
      const done = await backupDeployment({ destination: to! });
      console.log(`Backup written to ${done.destination}`);
      console.log('  myco.sqlite   consistent snapshot, taken with VACUUM INTO');
      console.log('  blobs/        content-addressed objects');
      return;
    }

    if (command === 'recovery-hold') {
      const selected = target();
      if (selected !== 'local' && selected !== 'cloudflare') fail('recovery-hold needs --target local or --target cloudflare.');
      const to = flags.get('to');
      const token = flags.get('token');
      const abandon = flags.has('abandon');
      if ((to === undefined || to === '' || to === 'true') && (token === undefined || token === '' || token === 'true')) {
        fail('recovery-hold needs --to <dir>, or --token <id> --abandon for a lost directory.');
      }
      const localPaths = resolveLocalPaths();
      if (selected === 'local' && !localDeploymentPresent(localPaths)) fail('No Deployment on this machine holds a recovery hold.');
      const owner = selected === 'local' ? localRecoveryHold(localPaths, carriedNative()) : cloudflareRecoveryHoldOf(cloudflareOptions());
      if (token !== undefined && token !== '' && token !== 'true') {
        if (!abandon) fail('recovery-hold --token reads nothing on its own; add --abandon to give that hold up.');
        const answer = await owner.release(token, 'abandoned');
        if (answer.state === 'other-holder') fail('that hold belongs to this Deployment\'s own export, not an operator backup.');
        console.log(`Recovery hold ${token} is ${answer.state}. Deferred deletions are decided again at the next pass.`);
        return;
      }
      if (to === undefined || to === '' || to === 'true') fail('recovery-hold needs --to <dir>, or --token <id> --abandon for a lost directory.');
      if (!abandon) {
        const held = await recoveryHoldOfDestination(to!, owner);
        console.log(`Recovery hold ${held.token} recorded by ${path.resolve(to!)} is ${held.state}.`);
        if (held.state === 'open') console.log('Every object its snapshot names is held: deletions are recorded and deferred until this backup completes or is given up.');
        if (held.state === 'open' && !held.sourceMatchesBinding) {
          console.log(held.bound
            ? 'The source no longer answers the Deployment this backup was bound to: it can only be replaced by a new capture.'
            : 'This hold is not yet bound to a source identity, so no snapshot may be captured under it.');
        }
        return;
      }
      const given = await abandonRecoveryHold(to!, owner, (line) => { console.log(line); });
      console.log(`Recovery hold ${given.token} is ${given.state}. Deferred deletions are decided again at the next pass.`);
      console.log('This destination can no longer be resumed; capture into a new directory.');
      return;
    }

    if (command === 'restore') {
      const selected = target();
      if (flags.has('new-signin') && selected !== 'cloudflare' && selected !== 'local') fail('--new-signin requires --target cloudflare or --target local.');
      const from = flags.get('from');
      if (from === undefined || from === '') fail('restore needs --from <dir>.');
      if (selected === 'cloudflare') {
        if (from === 'true') fail('restore needs --from <dir>.');
        const secretsFile = flags.get('secrets-from');
        if (secretsFile === undefined || secretsFile === '' || secretsFile === 'true') fail('hosted recovery needs --secrets-from <file> with independently held recovery credentials.');
        if (!flags.has('yes')) fail('hosted recovery provisions a new Deployment; re-run with --yes to confirm.');
        const restored = await restoreCloudflareDeployment({ ...cloudflareOptions(), source: from!, secretsFile: secretsFile!, newSignIn: flags.has('new-signin'), native: carriedNative() });
        console.log(`Replacement deployed at ${restored.record.url}, schema ${restored.schemaVersion}, Worker ${restored.record.versionId}.`);
        console.log('Source data was preserved. Sign-in, attached workers and embedding readiness still require verification before cutover.');
        if (flags.has('new-signin')) console.log(`Using the same MYCO_HOME (${resolveMycoHome()}), configure destination sign-in with: myco server github-app --target cloudflare --url ${restored.record.url} --name "Myco Recovery"`);
        return;
      }
      if (selected === 'local') {
        if (from === 'true') fail('restore needs --from <dir>.');
        const secretsFile = flags.get('secrets-from');
        if (secretsFile === undefined || secretsFile === '' || secretsFile === 'true') fail('native recovery needs --secrets-from <file> with independently held recovery credentials.');
        if (!flags.has('yes')) fail('native recovery publishes a new Deployment from the artifact; re-run with --yes to confirm.');
        const port = flags.get('port');
        const restored = await restoreLocalDeployment({ source: from!, secretsFile: secretsFile!, native: carriedNative(),
          newSignIn: flags.has('new-signin'),
          ...(port === undefined ? {} : { port: Number(port) }), report: (line) => console.log(line) });
        console.log(`Native recovery volume ready at schema ${restored.schemaVersion}. Source data was preserved.`);
        console.log(`Keep MYCO_HOME set to ${resolveMycoHome()} for this recovered Deployment.`);
        console.log(`Start it with this binary (${process.execPath}) and arguments: server run --target local`);
        return;
      }
      if (!flags.has('yes')) {
        fail(`restore replaces this Deployment's database and blobs with ${from}. Re-run with --yes to confirm.`);
      }
      await restoreDeployment({ source: from!, noDrain: flags.has('no-drain') });
      console.log('Deployment restored and restarted.');
      return;
    }

    if (command === 'rotate') {
      if (!flags.has('yes')) {
        fail('rotate replaces the session secret, which ends every signed-in session. Re-run with --yes to confirm.');
      }
      const rotated = await rotateSecrets({ report: (line) => console.log(line) });
      console.log(`Rotated: ${rotated.join(', ')}`);
      console.log('Every signed-in session has ended.');
      return;
    }

    if (command === 'adopt') {
      const result = await adoptDeployment();
      console.log(result.adopted
        ? `Adopted the running stack (${result.services.join(', ')}). The bundle is now in ${resolveDeploymentPaths().root}.`
        : `Bundle written to ${resolveDeploymentPaths().root}. No running stack was found; \`myco server create\` starts one.`);
      return;
    }

    if (command === 'destroy') {
      const removeData = flags.has('data');
      if (removeData && !flags.has('yes')) {
        fail('--data removes the Deployment volume and everything in it. Re-run with --yes to confirm.');
      }
      await destroyDeployment({ removeData });
      if (removeData) removeBundle(resolveDeploymentPaths());
      console.log(removeData ? 'Deployment and its data removed.' : 'Deployment stopped. Its data is kept.');
      return;
    }

    if (command === 'config') {
      let record = readDeploymentRecord();
      if (record === null) fail(`no Cloudflare deployment record on this machine (${deploymentRecordPath()}).`);
      const fleetFlag = flags.get('fleet');
      if (fleetFlag !== undefined) {
        const fleet = Number(fleetFlag);
        if (fleetFlag === 'true' || !Number.isInteger(fleet) || fleet < 1) fail('--fleet needs a whole number of runtimes, 1 or more.');
        record = { ...record, fleet };
        writeDeploymentRecord(record);
        console.log(`Fleet set to ${fleet} runtime${fleet === 1 ? '' : 's'}; the next \`server update\` deploys it.`);
      }
      const rendered = renderDeployConfig(record);
      const out = flags.get('out');
      if (out === undefined || out === '' || out === 'true') {
        process.stdout.write(rendered);
      } else {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(out, rendered, { mode: 0o600 });
        console.log(`Deploy config written to ${out}`);
      }
      return;
    }

    if (command === 'github-app') {
      const url = flags.get('url');
      if (url === undefined || url === 'true' || url === '') fail('github-app needs --url <https://…>, the address members open the dashboard at.');
      const target = resolveSignInTarget(flags.get('target'));
      const result = await registerGitHubApp({
        url: url!,
        org: flags.get('org'),
        name: flags.get('name'),
        target,
        openUrl: openInBrowser,
        log: (line) => console.log(line),
      });
      console.log(`\nGitHub App:  ${result.app.name}, owned by ${result.app.ownerLogin ?? 'your account'} (${result.app.htmlUrl})`);
      console.log(`Callback:    ${result.callbackUrl}`);
      console.log(`Installed:   ${target.kind === 'cloudflare' ? `Worker ${target.record.workerName}` : target.paths.root}`);
      if (result.verified.ok) console.log(`Verified:    ${url} sends sign-in to GitHub and back.`);
      else if (result.verified.pendingStart) console.log(`Next:        ${result.verified.reason}`);
      else fail(`Installed, but sign-in did not verify: ${result.verified.reason}`);
      return;
    }

    console.error(`Unknown command: ${command}\n`);
    console.log(SERVER_HELP);
    process.exit(2);
  } catch (err) {
    // A rolled-back update is a failure, and the operator needs to know the
    // Deployment is serving again on the version it started from.
    if (err instanceof UpdateRolledBack || err instanceof UpdateRollbackFailed || err instanceof HarnessLeftStopped) fail(err.message);
    if (err instanceof RestoreLeftIncomplete || err instanceof ComposeFilesUnreadable) fail(err.message);
    if (err instanceof RegistrationRefused || err instanceof WranglerNotReady) fail(err.message);
    if (err instanceof DeployConfigIncomplete) fail(err.message);
    if (err instanceof LocalDeploymentAbsent || err instanceof LocalRecordUnreadable) fail(err.message);
    if (err instanceof ServicePathUnsupported || err instanceof ServicePlatformUnsupported) fail(err.message);
    // A Compose failure is the operator's to read, verbatim.
    if (err instanceof CommandFailed) fail(err.message);
    fail(err instanceof Error ? err.message : String(err));
  }
}
