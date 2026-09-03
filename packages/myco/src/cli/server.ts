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
  backupDeployment,
  restoreDeployment,
  updateDeployment,
  rotateSecrets,
  adoptDeployment,
} from '../server/deployment.js';
import { CommandFailed } from '../server/runner.js';
import { UpdateRolledBack } from '../server/deployment.js';
import { registerGitHubApp, RegistrationRefused, resolveSignInTarget } from '../server/github-app.js';
import { WranglerAbsent, readDeploymentRecord, writeDeploymentRecord } from '../server/cloudflare.js';
import { DeployConfigIncomplete, renderDeployConfig } from '../server/deploy-config.js';
import { cloudflareDeploymentStatus, createCloudflareDeployment, destroyCloudflareDeployment, rollbackCloudflareDeployment, updateCloudflareDeployment } from '../server/cloudflare-lifecycle.js';
import { existsSync } from 'node:fs';
import { parseFlags } from './shared.js';

export const SERVER_HELP = `Usage: myco server <command>

Commands (Compose is the default target; --target cloudflare selects the Worker):
  create [--port <n>] [--version <tag>]   Provision and start the Deployment.
  create --target cloudflare --account-id <id> --dir <packages/myco-server checkout>
                                          Provision D1/R2/secrets store, install generated secrets,
                                          migrate, deploy, and write the deployment record.
  status                                  Report what is provisioned and running.
                                          With --target cloudflare: the record and the deployed version.
  update [--version <tag>] [--no-rollback]
                                          Move to a new image; the container migrates on start.
                                          A failed update returns to the previous version.
  rollback --target cloudflare [--version <id>] [--message <text>]
                                          Return the Worker to an earlier version. Defaults to the
                                          record's last recorded one — the version a failed update
                                          left serving.
  backup --to <dir>                       Snapshot the database and blobs.
  restore --from <dir>                    Replace the Deployment's data with a backup.
  rotate [--yes]                           Replace generated secrets. Ends every signed-in session.
  adopt                                   Write a bundle for a stack this machine did not provision.
  destroy [--data] [--yes]                Stop and remove the stack. --data also removes the volume.
                                          With --target cloudflare: removes the Worker only; data stands.
  config [--out <path>] [--fleet <n>]     Render the Cloudflare deploy config from the committed
                                          configuration and this machine's deployment record.
                                          --fleet sets how many runtimes the server may start at
                                          once; the next update deploys it.
  github-app --url <https://…> [--org <name>] [--name <text>] [--target cloudflare|compose]
                                          Register the dashboard's sign-in app on GitHub (one click
                                          there) and install its credentials on the Deployment.

The bundle is ordinary Compose. Everything here is also runnable with
\`docker compose\` from the deployment directory.`;

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

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export async function run(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(SERVER_HELP);
    process.exit(command === undefined ? 2 : 0);
  }

  const { flags } = parseFlags(rest);

  /** Which target a lifecycle verb acts on: named, else the one this machine holds. */
  const target = (): 'cloudflare' | 'compose' => {
    const named = flags.get('target');
    if (named === 'cloudflare' || named === 'compose') return named;
    if (named !== undefined) fail(`--target must be cloudflare or compose, and is ${JSON.stringify(named)}`);
    const record = readDeploymentRecord();
    const bundle = existsSync(resolveDeploymentPaths().composeFile);
    if (record !== null && bundle) fail('this machine holds both a Cloudflare record and a Compose bundle; pass --target cloudflare or --target compose');
    return record !== null ? 'cloudflare' : 'compose';
  };

  /** The Cloudflare lifecycle inputs a verb needs; only a deploying verb needs a checkout. */
  const cloudflareOptions = (needs: { checkout: boolean }) => {
    const record = readDeploymentRecord();
    const accountId = flags.get('account-id') ?? record?.accountId;
    if (accountId === undefined || accountId === '' || accountId === 'true') fail('pass --account-id <id> (npx wrangler whoami lists the accounts this login reaches).');
    const dir = flags.get('dir');
    if (needs.checkout && (dir === undefined || dir === '' || dir === 'true')) fail('pass --dir <path to packages/myco-server in a checkout at the version to deploy>.');
    return { accountId, configDir: dir !== undefined && dir !== '' && dir !== 'true' ? dir : process.cwd() };
  };

  try {
    if (command === 'create' && target() === 'cloudflare') {
      const created = await createCloudflareDeployment(cloudflareOptions({ checkout: true }));
      console.log('\nCloudflare Deployment deployed.');
      if (created.createdResources.length > 0) console.log(`  Provisioned: ${created.createdResources.join(', ')}`);
      console.log(`  Version:     ${created.versionId ?? 'unknown'}`);
      console.log('  Record:      ~/.myco/server/cloudflare/record.json');
      if (created.record.url !== undefined) console.log(`  URL:         ${created.record.url}`);
      return;
    }

    if (command === 'status' && target() === 'cloudflare') {
      if (readDeploymentRecord() === null) { console.log('No Cloudflare Deployment record. myco server create --target cloudflare provisions one.'); return; }
      const status = (await cloudflareDeploymentStatus(cloudflareOptions({ checkout: false })))!;
      console.log('\nCloudflare Deployment');
      console.log(`  Worker:     ${status.record.workerName} (account ${status.record.accountId})`);
      console.log(`  Deployed:   ${status.deployed ? status.versionId ?? 'yes' : 'no'}`);
      console.log(`  Recorded:   ${status.record.versionId ?? 'never'} at ${status.record.deployedAt}`);
      if (status.record.url !== undefined) console.log(`  URL:        ${status.record.url}`);
      return;
    }

    if (command === 'rollback' && target() === 'cloudflare') {
      const versionFlag = flags.get('version');
      const messageFlag = flags.get('message');
      if (versionFlag === '' || versionFlag === 'true') fail('pass --version <id> (`wrangler deployments list` names them), or omit the flag to use the record\'s last recorded version.');
      const rolled = await rollbackCloudflareDeployment({
        ...cloudflareOptions({ checkout: false }),
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
      const updated = await updateCloudflareDeployment(cloudflareOptions({ checkout: true }));
      console.log(`Cloudflare Deployment updated to version ${updated.versionId ?? 'unknown'} (migrations first, then the Worker).`);
      return;
    }

    if (command === 'destroy' && target() === 'cloudflare') {
      if (flags.has('data')) fail('--data does not apply to the Worker target: the database, bucket, and secrets store are never removed by this command.');
      if (!flags.has('yes')) fail('destroy removes the Worker. The database, bucket, and secrets store are kept. Re-run with --yes to confirm.');
      const destroyed = await destroyCloudflareDeployment(cloudflareOptions({ checkout: false }));
      console.log(`Worker removed. Kept: ${destroyed.kept.join(', ')}.`);
      return;
    }

    if (command === 'create') {
      const portFlag = flags.get('port');
      const port = portFlag === undefined ? undefined : Number(portFlag);
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
        fail(`--port must be a port number, and is ${JSON.stringify(portFlag)}`);
      }
      const created = await createDeployment({ port, version: flags.get('version') });
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
      console.log(`  Running:    ${status.running ? status.services.join(', ') : 'no'}`);
      return;
    }

    if (command === 'update') {
      await updateDeployment({ version: flags.get('version'), noRollback: flags.has('no-rollback') });
      console.log('Deployment updated. The container applied any migrations its volume was behind.');
      return;
    }

    if (command === 'backup') {
      const to = flags.get('to');
      if (to === undefined || to === '') fail('backup needs --to <dir>.');
      const done = await backupDeployment({ destination: to! });
      console.log(`Backup written to ${done.destination}`);
      console.log('  myco.sqlite   consistent snapshot, taken with VACUUM INTO');
      console.log('  blobs/        content-addressed objects');
      return;
    }

    if (command === 'restore') {
      const from = flags.get('from');
      if (from === undefined || from === '') fail('restore needs --from <dir>.');
      if (!flags.has('yes')) {
        fail(`restore replaces this Deployment's database and blobs with ${from}. Re-run with --yes to confirm.`);
      }
      await restoreDeployment({ source: from! });
      console.log('Deployment restored and restarted.');
      return;
    }

    if (command === 'rotate') {
      if (!flags.has('yes')) {
        fail('rotate replaces the session secret, which ends every signed-in session. Re-run with --yes to confirm.');
      }
      const rotated = await rotateSecrets();
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
      if (record === null) fail('no Cloudflare deployment record on this machine (~/.myco/server/cloudflare.json).');
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
      else fail(`Installed, but sign-in did not verify: ${result.verified.reason}`);
      return;
    }

    console.error(`Unknown command: ${command}\n`);
    console.log(SERVER_HELP);
    process.exit(2);
  } catch (err) {
    // A rolled-back update is a failure, and the operator needs to know the
    // Deployment is serving again on the version it started from.
    if (err instanceof UpdateRolledBack) fail(err.message);
    if (err instanceof RegistrationRefused || err instanceof WranglerAbsent) fail(err.message);
    if (err instanceof DeployConfigIncomplete) fail(err.message);
    // A Compose failure is the operator's to read, verbatim.
    if (err instanceof CommandFailed) fail(err.message);
    fail(err instanceof Error ? err.message : String(err));
  }
}
