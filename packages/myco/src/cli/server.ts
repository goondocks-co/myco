import { REJOIN_HINT } from '@goondocks/myco-shared/member-protocol';
import nodeFs from 'node:fs';
import { CommandFailed, type CommandRunner } from '../server/runner.js';
import { discardSignInPending, registerGitHubApp, RegistrationRefused, resolveSignInTarget } from '../server/github-app.js';
import { WranglerNotReady, cloudflareCredentialLines, deploymentRecordPath, peekDeploymentRecord, readDeploymentRecord, writeDeploymentRecord } from '../server/cloudflare.js';
import { DeployConfigIncomplete, renderDeployConfig } from '../server/deploy-config.js';
import { type CreatePlan, cloudflareUpdateLines, cloudflareDeploymentStatus, createCloudflareDeployment, destroyCloudflareDeployment, planCloudflareDeployment, rollbackCloudflareDeployment, updateCloudflareDeployment } from '../server/cloudflare-lifecycle.js';
import { composeRetiredMessage, retiredComposeBundle } from '../server/targets.js';
import { parseFlags } from './flags.js';
import path from 'node:path';
import { ownerLinkNext } from '@goondocks/myco-shared/setup-guidance';
import { resolveMycoHome } from '../paths/home.js';

import {
  DEFAULT_LOCAL_RECORD,
  LocalDeploymentAbsent,
  LocalRecordUnreadable,
  createLocalDeployment,
  localDeploymentPresent,
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
import { setupCloudflareOwner } from '../server/cloudflare-owner.js';
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
  setup-owner --target cloudflare         The same for the hosted Deployment this machine created, over
                                          its database with your Cloudflare login; it keeps serving.
                                          Needs its GitHub sign-in (\`myco server github-app\`) first.
  create --target local [--port <n>]      Provision a Deployment this machine runs itself: a data
                                          directory, generated secrets, and a migrated volume.
  run --target local                      Serve it in the foreground. This is what the service runs.
  install --target local                  Run it whenever you log in, restarting it if it stops.
  uninstall --target local                Stop it and remove the service. Its data is kept.

  create --target cloudflare --account-id <id> [--url <https://…>] [--dry-run]
                                          Provision D1/R2/Vectorize/secrets store, install generated
                                          secrets, migrate, deploy, and write the deployment record.
                                          Needs Node and a wrangler login on this machine and nothing
                                          else: the Worker, its dashboard and its migrations all
                                          travel in this binary. --url puts it on a domain you own.
                                          --dry-run lists what it would create, keep and bind, and
                                          changes nothing. Then: github-app, then setup-owner.
  status                                  Report what is provisioned and running.
                                          With --target cloudflare: the record and the deployed version.
  update --target local                   Apply the schema carried by this binary to the stopped volume.
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
  backup --to <dir> [--target local|cloudflare]
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
  restore --target local|cloudflare ... --source-retired
                                          Confirm that the original serving instance is retired.
  restore --target local|cloudflare ... --fork
                                          Create a new tenant, preserving history and ending copied
                                          credentials, invitations, access keys and active runs.
                                          Replacement retains the tenant and requires --source-retired.
  destroy --target local [--data] [--yes] Remove the service; --data also removes its data.
  destroy --target cloudflare --yes       Remove the Worker; its database, bucket and secrets store stay.
  config [--out <path>] [--fleet <n>]     Render the Cloudflare deploy config from the committed
                                          configuration and this machine's deployment record.
                                          --fleet sets how many runtimes the server may start at
                                          once; the next update deploys it.
  github-app --existing --client-id <id> --client-secret-stdin --url <url> [--target local|cloudflare]
                                          Install an app you already own after regenerating its secret.
  github-app --url <https://…> [--org <name>] [--app-name <text>] [--target local|cloudflare]
                                          --name is an alias for --app-name.
                                          Native setup requires a stopped server. Stop a foreground run
                                          with Ctrl-C, or use server uninstall to stop its service.
                                          Start it again after setup to use the new sign-in credentials.
                                          Register the dashboard's sign-in app on GitHub (one click
                                          there) and install its credentials on the Deployment.
  github-app --discard-pending [--target local|cloudflare]
                                          Print the saved app URL, then discard its unfinished registration.
                                          Delete or reuse that app on GitHub before registering another.

A Deployment run from this binary needs no container runtime and no Node.
The Cloudflare target needs Node and wrangler on THIS machine, and neither on
the Deployment.`;

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

/** What `create --target cloudflare --dry-run` prints: each step with what it would do, the bindings, and the address. */
export function createPlanLines(plan: CreatePlan): string[] {
  const width = Math.max(...plan.steps.map((s) => s.action.length));
  return [
    `\nCloudflare Deployment plan for account ${plan.accountId}. Nothing was created or changed.`,
    ...plan.steps.map((s) => `  ${s.action.padEnd(width)}  ${s.kind} ${s.displayName ?? s.name}`),
    `  Bindings:  ${plan.bindings.join(', ')}`,
    `  URL:       ${plan.url}`,
    '\nRun the same command without --dry-run to carry it out.',
  ];
}

/** The two commands after a hosted create, in order: its GitHub sign-in, then its first administrator. */
export function hostedNextSteps(url: string | undefined): string[] {
  return [
    '\nNext:',
    `  1. myco server github-app --target cloudflare --url ${url ?? '<the Deployment\'s https address>'}`,
    '  2. myco server setup-owner --target cloudflare',
  ];
}

export async function run(args: string[], deps: { runner?: CommandRunner; fetchImpl?: typeof fetch; openUrl?: (url: string) => Promise<void>; readSecret?: () => Promise<string>; cloudflareOwner?: typeof setupCloudflareOwner; localOwner?: typeof setupLocalOwner } = {}): Promise<void> {
  const [command, ...rest] = args;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(SERVER_HELP);
    process.exit(command === undefined ? 2 : 0);
  }

  const { flags } = parseFlags(rest);
  const credentialLines = cloudflareCredentialLines();
  const emittedCredentials = new Set<string>();
  const report = (line: string): void => {
    if (credentialLines.includes(line)) {
      if (emittedCredentials.has(line)) return;
      emittedCredentials.add(line);
    }
    console.log(line);
  };

  /** Which target a lifecycle verb acts on: named, else the one this machine holds. */
  const target = (): 'cloudflare' | 'local' => {
    const named = flags.get('target');
    if (named === 'compose') fail(composeRetiredMessage(retiredComposeBundle()));
    if (named === 'cloudflare' || named === 'local') return named;
    if (named !== undefined) fail(`--target must be local or cloudflare, and is ${JSON.stringify(named)}`);
    const held: string[] = [];
    if (readDeploymentRecord() !== null) held.push('cloudflare');
    const bundle = retiredComposeBundle();
    if (bundle !== null) fail(composeRetiredMessage(bundle));
    if (localDeploymentPresent()) held.push('local');
    // Two Deployments on one machine is a choice the operator makes per verb,
    // never one this guesses from what happens to be on disk.
    if (held.length > 1) fail(`this machine holds more than one Deployment (${held.join(', ')}); pass --target ${held.join(' or --target ')}`);
    return (held[0] as 'cloudflare' | 'local' | undefined) ?? 'local';
  };

  /** The Cloudflare lifecycle inputs a verb needs; only a deploying verb needs a checkout. */
  const cloudflareOptions = () => {
    // A flag this target refuses by name is answered first: a refusal about a
    // missing value tells an operator to supply one, which is the wrong move
    // when the flag beside it does not apply here at all.
    if (flags.has('dir')) fail('--dir is not a flag for this target: the Worker, its dashboard and its migrations all travel in this binary, so a deploy reads no checkout.');
    if (flags.has('no-drain')) fail('--no-drain is not a flag for this target: a deploy replaces no runtime, so it waits for nothing.');
    // A plan reads the record where it lies; every other verb reads it through the layout move.
    const record = flags.has('dry-run') ? peekDeploymentRecord() : readDeploymentRecord();
    const accountId = flags.get('account-id') ?? record?.accountId;
    if (accountId === undefined || accountId === '' || accountId === 'true') fail('pass --account-id <id> (npx wrangler whoami lists the accounts this login reaches).');
    for (const line of credentialLines) report(line);
    return { accountId, ...(deps.runner === undefined ? {} : { runner: deps.runner }), report };
  };

  /** Where this machine's own Deployment lives, and what it is running under. */
  const localSpec = () => defaultSpec(process.execPath, undefined, undefined, resolveMycoHome());


  try {
    if (flags.get('target') === 'compose') fail(composeRetiredMessage(retiredComposeBundle()));
    if (command === 'rotate' || command === 'adopt') fail(`myco server ${command} is retired. Use myco server create --target local.`);
    if (command === 'setup-owner' && target() === 'cloudflare') {
      const result = await (deps.cloudflareOwner ?? setupCloudflareOwner)(cloudflareOptions());
      console.log(`First administrator: ${result.memberId}`);
      console.log('Open this private link, sign in with GitHub and connect your account; that account becomes the administrator:');
      console.log(result.url);
      console.log(`Expires: ${new Date(result.expiresAt).toISOString()}. Keep this link private.`);
      console.log(ownerLinkNext(result.url, 'cloudflare'));
      return;
    }
    if (command === 'setup-owner') {
      if (target() !== 'local') fail('setup-owner requires --target local or --target cloudflare');
      const result = await (deps.localOwner ?? setupLocalOwner)(resolveLocalPaths(), carriedNative());
      console.log(`First administrator: ${result.memberId}`);
      console.log('Start the Deployment, then open this private link and connect your GitHub account:');
      console.log(result.url);
      console.log(`Expires: ${new Date(result.expiresAt).toISOString()}. Keep this link private.`);
      console.log(ownerLinkNext(result.url, 'local'));
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
        console.log(`Agent work requires an explicitly opted-in machine: on this machine or another, run \`myco runner register http://127.0.0.1:${started.port}\` (use this Deployment's reachable address remotely), then \`myco runner install\`.`);
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
      if (flags.has('dry-run')) {
        const plan = await planCloudflareDeployment({ ...cloudflareOptions(), ...(urlFlag === undefined ? {} : { url: urlFlag }) });
        for (const line of createPlanLines(plan)) console.log(line);
        return;
      }
      const created = await createCloudflareDeployment({ ...cloudflareOptions(), ...(urlFlag === undefined ? {} : { url: urlFlag }) });
      console.log('\nCloudflare Deployment deployed.');
      if (created.createdResources.length > 0) console.log(`  Provisioned: ${created.createdResources.join(', ')}`);
      console.log(`  Version:     ${created.versionId ?? 'unknown'}`);
      // The path this home actually holds it at: a `MYCO_HOME` somewhere else
      // makes a literal a file the operator will not find.
      console.log(`  Record:      ${deploymentRecordPath()}`);
      if (created.record.url !== undefined) console.log(`  URL:         ${created.record.url}`);
      for (const line of hostedNextSteps(created.record.url)) console.log(line);
      return;
    }

    if (command === 'status' && target() === 'cloudflare') {
      if (readDeploymentRecord() === null) { console.log('No Cloudflare Deployment record. myco server create --target cloudflare provisions one.'); return; }
      const status = (await cloudflareDeploymentStatus(cloudflareOptions()))!;
      console.log('\nCloudflare Deployment');
      console.log(`  Worker:     ${status.record.workerName} (account ${status.record.accountId})`);
      console.log(`  Worker (live): ${status.workerError === null ? status.deployed ? status.versionId ?? 'version unavailable' : 'not deployed' : `unavailable — ${status.workerError}`}`);
      console.log(`  Worker (recorded): ${status.record.versionId ?? 'never'} at ${status.record.deployedAt}`);
      console.log(`  Release (recorded at last deploy): ${status.record.release ?? 'unknown (not recorded)'}`);
      console.log(`  Schema (live): ${status.schema ?? `unavailable — ${status.schemaError}`}`);
      console.log(`  URL (recorded): ${status.record.url ?? 'unknown'}`);
      if (status.workerError === null && status.deployed && status.versionId !== null && status.versionId !== status.record.versionId) {
        console.log(`The live Worker is version ${status.versionId}, not the one recorded; run myco server status --target cloudflare after the deploy settles. The recorded release does not identify the live Worker.`);
      }
      const lastSchema = status.record.schemaUpdates?.at(-1);
      if (lastSchema !== undefined) {
        console.log(`  Last schema update (${lastSchema.appliedAt !== undefined ? 'applied' : status.schema === lastSchema.schemaAfter ? 'completed; confirmed by live schema' : 'recovery point recorded; migration not confirmed'}): ${lastSchema.schemaBefore} → ${lastSchema.schemaAfter} at ${lastSchema.appliedAt ?? lastSchema.recordedAt}, bookmark ${lastSchema.bookmark}`);
      }
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
      fail('rollback is a --target cloudflare verb.');
    }

    if (command === 'update' && target() === 'cloudflare') {
      const updated = await updateCloudflareDeployment(cloudflareOptions());
      for (const line of cloudflareUpdateLines(updated.summary)) console.log(line);
      console.log(`  Worker version applied: ${updated.versionId ?? 'unknown'}.`);
      return;
    }

    if (command === 'destroy' && target() === 'cloudflare') {
      if (flags.has('data')) fail('--data does not apply to the Worker target: the database, bucket, and secrets store are never removed by this command.');
      if (!flags.has('yes')) fail('destroy removes the Worker. The database, bucket, and secrets store are kept. Re-run with --yes to confirm.');
      const destroyed = await destroyCloudflareDeployment(cloudflareOptions());
      console.log(`Worker removed. Kept: ${destroyed.kept.join(', ')}.`);
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
      const report = (line: string) => { console.log(line); };
      const done = selected === 'local'
        ? await backupLocalDeployment({ destination: to!, report, native: carriedNative() })
        : await backupCloudflareDeployment({ ...cloudflareOptions(), destination: to!, report });
      console.log(`Verified data artifact written to ${path.resolve(to!)} (${done.snapshot!.blobCount} blobs)`);
      console.log(credentialsReport(done.snapshot!.credentialsRequired));
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
      if (flags.has('source-retired') && selected !== 'cloudflare' && selected !== 'local') fail('--source-retired requires --target cloudflare or --target local.');
      if (flags.has('fork') && selected !== 'cloudflare' && selected !== 'local') fail('--fork requires --target cloudflare or --target local.');
      if (flags.has('new-signin') && selected !== 'cloudflare' && selected !== 'local') fail('--new-signin requires --target cloudflare or --target local.');
      const from = flags.get('from');
      if (from === undefined || from === '') fail('restore needs --from <dir>.');
      if (selected === 'cloudflare') {
        if (from === 'true') fail('restore needs --from <dir>.');
        const secretsFile = flags.get('secrets-from');
        if (secretsFile === undefined || secretsFile === '' || secretsFile === 'true') fail('hosted recovery needs --secrets-from <file> with independently held recovery credentials.');
        if (!flags.has('yes')) fail('hosted recovery provisions a new Deployment; re-run with --yes to confirm.');
        const restored = await restoreCloudflareDeployment({ ...cloudflareOptions(), source: from!, secretsFile: secretsFile!, newSignIn: flags.has('new-signin'), tenantMode: flags.has('fork') ? 'fork' : 'replacement', sourceRetired: flags.has('source-retired'), native: carriedNative() });
        console.log(`${flags.has('fork') ? 'Fork' : 'Replacement'} deployed at ${restored.record.url}, schema ${restored.schemaVersion}, Worker ${restored.record.versionId}.`);
        console.log(flags.has('fork') ? `A new tenant was created. Copied credentials, invitations and agent access keys are inactive. ${REJOIN_HINT}` : 'The Deployment identity and carried live authority were retained. This is the same tenant.');
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
          tenantMode: flags.has('fork') ? 'fork' : 'replacement', sourceRetired: flags.has('source-retired'),
          ...(port === undefined ? {} : { port: Number(port) }), report: (line) => console.log(line) });
        console.log(`Native recovery volume ready at schema ${restored.schemaVersion}. Source data was preserved.`);
        console.log(flags.has('fork') ? `A new tenant was created. Copied credentials, invitations and agent access keys are inactive. ${REJOIN_HINT}` : 'The Deployment identity and carried live authority were retained. This is the same tenant.');
        console.log(`Keep MYCO_HOME set to ${resolveMycoHome()} for this recovered Deployment.`);
        console.log(`Start it with this binary (${process.execPath}) and arguments: server run --target local`);
        return;
      }
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
        nodeFs.writeFileSync(out, rendered, { mode: 0o600 });
        console.log(`Deploy config written to ${out}`);
      }
      return;
    }

    if (command === 'github-app') {
      if (flags.has('discard-pending')) {
        if (['existing', 'client-id', 'client-secret', 'client-secret-stdin', 'org', 'name', 'app-name'].some((key) => flags.has(key))) fail('--discard-pending cannot be combined with app registration or credentials. Run myco server github-app --discard-pending --target <target> on its own.');
        await discardSignInPending(resolveSignInTarget(flags.get('target')), (line) => console.log(line));
        return;
      }
      const url = flags.get('url');
      if (url === undefined || url === 'true' || url === '') fail('github-app needs --url <https://…>, the address members open the dashboard at.');
      const existing = flags.has('existing');
      const clientId = flags.get('client-id');
      if (existing && (!clientId || clientId === 'true' || !flags.has('client-secret-stdin'))) fail('--existing needs --client-id <id> --client-secret-stdin; regenerate the app secret on GitHub, then pipe it to this command.');
      if (!existing && (clientId !== undefined || flags.has('client-secret-stdin'))) fail('--client-id and --client-secret-stdin require --existing.');
      if (flags.has('client-secret')) fail('pipe the regenerated secret to --client-secret-stdin; do not pass --client-secret.');
      if (existing && flags.has('org')) fail('--org applies to registering a new app; omit it with --existing.');
      const target = resolveSignInTarget(flags.get('target'));
      const clientSecret = existing ? await (deps.readSecret ?? readSignInSecret)() : undefined;
      if (target.kind === 'cloudflare') for (const line of credentialLines) report(line);
      const result = await registerGitHubApp({
        url: url!,
        org: flags.get('org'),
        name: flags.get('app-name') ?? flags.get('name'),
        existing: existing ? { clientId: clientId!, clientSecret: clientSecret! } : undefined,
        target,
        runner: deps.runner,
        fetchImpl: deps.fetchImpl,
        openUrl: deps.openUrl ?? openInBrowser,
        log: (line) => console.log(line),
      });
      console.log(`\nGitHub App:  ${result.app.name} (${result.app.htmlUrl})`);
      console.log(`Owner: ${existing ? 'not checked' : result.app.ownerLogin ?? 'not reported by GitHub'}`);
      console.log(`Callback:    ${result.callbackUrl}${existing ? ' must be listed in the app' : ''}`);
      console.log(`Installed:   ${target.kind === 'cloudflare' ? `Worker ${target.record.workerName}` : target.paths.root}`);
      if (result.verified.ok) console.log(`Sign-in:     ${new URL(url!).origin} sends sign-in to GitHub with client ${result.app.clientId}; sign in once to confirm.`);
      else if (result.verified.pendingStart) console.log(`Next:        ${result.verified.reason}`);
      else fail(`Installed, but sign-in did not verify: ${result.verified.reason}`);
      return;
    }

    console.error(`Unknown command: ${command}\n`);
    console.log(SERVER_HELP);
    process.exit(2);
  } catch (err) {
    if (err instanceof RegistrationRefused || err instanceof WranglerNotReady) fail(err.message);
    if (err instanceof DeployConfigIncomplete) fail(err.message);
    if (err instanceof LocalDeploymentAbsent || err instanceof LocalRecordUnreadable) fail(err.message);
    if (err instanceof ServicePathUnsupported || err instanceof ServicePlatformUnsupported) fail(err.message);
    if (err instanceof CommandFailed) fail(err.message);
    fail(err instanceof Error ? err.message : String(err));
  }
}

/** Read one piped secret without terminal echo or command-line exposure. */
async function readSignInSecret(): Promise<string> {
  if (process.stdin.isTTY) throw new RegistrationRefused('pipe the regenerated GitHub secret to --client-secret-stdin.');
  let value = '';
  for await (const chunk of process.stdin) value += String(chunk);
  return value.replace(/\r?\n$/, '');
}
