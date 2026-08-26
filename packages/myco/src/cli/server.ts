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
import { parseFlags } from './shared.js';

export const SERVER_HELP = `Usage: myco server <command>

Commands:
  create [--port <n>] [--version <tag>]   Provision and start the Deployment.
  status                                  Report what is provisioned and running.
  update [--version <tag>] [--no-rollback]
                                          Move to a new image; the container migrates on start.
                                          A failed update returns to the previous version.
  backup --to <dir>                       Snapshot the database and blobs.
  restore --from <dir>                    Replace the Deployment's data with a backup.
  rotate [--yes]                           Replace generated secrets. Ends every signed-in session.
  adopt                                   Write a bundle for a stack this machine did not provision.
  destroy [--data] [--yes]                Stop and remove the stack. --data also removes the volume.

The bundle is ordinary Compose. Everything here is also runnable with
\`docker compose\` from the deployment directory.`;

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

  try {
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

    console.error(`Unknown command: ${command}\n`);
    console.log(SERVER_HELP);
    process.exit(2);
  } catch (err) {
    // A rolled-back update is a failure, and the operator needs to know the
    // Deployment is serving again on the version it started from.
    if (err instanceof UpdateRolledBack) fail(err.message);
    // A Compose failure is the operator's to read, verbatim.
    if (err instanceof CommandFailed) fail(err.message);
    fail(err instanceof Error ? err.message : String(err));
  }
}
