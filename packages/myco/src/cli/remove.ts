import fs from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { parseStrictFlags } from './args.js';
import { confirmDestructive } from './confirm.js';
import { isMemberHome, legacyVaultFiles } from '../member/home-role.js';
import { LEGACY_MIGRATION_GUIDANCE } from '../member/migration-guidance.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { SymbiontInstaller } from '../symbionts/installer.js';
import { readProvisionRecord } from '../symbionts/member-provision-record.js';
import { prepareMemberSkillRemoval, skillsFolder } from '../symbionts/member-skill-links.js';
import { readDefaultDeployment } from '../member/default-deployment.js';
import { sweepWorkerServices, type WorkerServiceDeps } from './worker-service.js';
import { withCloudflareOperation } from '../server/cloudflare-operation.js';
import { LocalVolume } from '../server/local-volume.js';
import { resolveLocalPaths } from '../server/local.js';
import { listRunnerRecords } from '../runner/runner-registry.js';

export const USAGE = `Usage: myco remove [--purge] [--allow-deployment-loss] [--yes]

Remove this home's global member hooks, MCP registrations and skill links,
and its worker and runner services. Repository files and Myco 1.4 homes
are preserved. Member credentials and captured data stay unless --purge is passed.
Shared Windows binaries outside this home stay installed.

Options:
  --purge                  Delete the 2.0 home, including credentials and buffered capture
  --allow-deployment-loss  With --purge, also allow loss of Deployment data and operator records
  --yes                    Skip the confirmation prompt
  -h, --help               Show this help
`;

interface RemoveDeps {
  mycoHome?: string;
  worker?: WorkerServiceDeps;
  confirm?: typeof confirmDestructive;
}

const LEGACY_HOME_ENTRIES = ['groves', 'myco.db', 'config.yaml', 'myco.yaml', 'service'];
const DEPLOYMENT_LEASE_FILES = ['cloudflare.lock', 'local.lock'];

/** Existing paths whose loss requires separate, explicit consent. */
export function deploymentLosses(home: string): string[] {
  const losses: string[] = [];
  if (fs.existsSync(path.join(home, 'server'))) {
    losses.push(`Deployment files at ${path.join(home, 'server')} (all retained contents, including any databases, object storage, configuration and credentials). `
      + 'Back it up outside this home with `myco server backup --target local --to <backup-dir>`, or move the Deployment first.');
  }
  for (const record of [path.join(home, 'server', 'cloudflare', 'record.json'), path.join(home, 'server', 'cloudflare.json')]) {
    if (fs.existsSync(record)) losses.push(`Cloudflare operator record at ${record} (Deployment resource identities and recovery metadata). `
      + 'Back up the Deployment with `myco server backup --target cloudflare --to <backup-dir>` and move this operator record outside the home first.');
  }
  return losses;
}

/** Remove member-owned integrations and an explicitly admitted 2.0 home. */
export async function run(args: string[], deps: RemoveDeps = {}): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(USAGE); return; }
  const parsed = parseStrictFlags('myco remove', args, [
    { name: '--purge' }, { name: '--allow-deployment-loss' }, { name: '--yes' },
  ], USAGE);
  const home = deps.mycoHome ?? resolveMycoHome();
  const purge = parsed.has('--purge');
  const allowLoss = parsed.has('--allow-deployment-loss');
  if (allowLoss && !purge) throw new Error('--allow-deployment-loss requires --purge.');
  if (purge && [home, path.join(home, 'server')].some(file => fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())) {
    throw new Error('Refusing --purge of a symlinked home or Deployment directory; no files were removed.');
  }
  if (LEGACY_HOME_ENTRIES.some(entry => fs.existsSync(path.join(home, entry))) || legacyVaultFiles(home).length > 0) {
    console.error(`Refusing to remove a Myco 1.4 home at ${home}. ${LEGACY_MIGRATION_GUIDANCE}`);
    process.exitCode = 1;
    return;
  }
  const losses = deploymentLosses(home);
  if (purge && fs.existsSync(home) && !isMemberHome(home) && listRunnerRecords(home).length === 0 && losses.length === 0) {
    console.error(`Refusing --purge: ${home} is not a registered Myco 2.0 home. Its files were preserved.`);
    process.exitCode = 1;
    return;
  }
  if (purge && losses.length > 0 && !allowLoss) {
    console.error(`Refusing --purge. It would lose:\n${losses.join('\n')}\n`
      + 'After backing up or moving it, pass --purge --allow-deployment-loss to proceed anyway.');
    process.exitCode = 1;
    return;
  }
  const summary = `Remove this home's member registrations and worker/runner services. `
    + (purge ? `DELETE ${home} (credentials and buffered capture).\n${losses.join('\n')}` : `Preserve data at ${home}.`);
  if (!parsed.has('--yes') && !await (deps.confirm ?? confirmDestructive)(summary)) {
    console.error('Aborted — nothing was removed.');
    process.exitCode = 1;
    return;
  }
  const deployment = readProvisionRecord(home)?.serverUrl ?? readDefaultDeployment(home)?.serverUrl ?? null;
  const registrations = loadManifests().map(manifest => {
    const installer = new SymbiontInstaller(manifest, home, resolvePackageRoot(), false, undefined, null, 'member-global', home).withoutProjectRoot();
    if (deployment !== null) installer.forDeployment(deployment);
    const hooks = installer.inspectMemberHooks();
    const mcp = installer.inspectMemberMcp();
    if (!hooks.readable || mcp.some(entry => !entry.readable)) throw new Error(`Cannot read ${manifest.displayName}'s member registration; removal aborted.`);
    const registered = hooks.member || mcp.some(entry => entry.carriesCredential);
    if (registered) installer.assertMemberUninstallable();
    const target = manifest.registration?.globalSkillsTarget;
    const removeSkills = target ? prepareMemberSkillRemoval(home, skillsFolder(target)) : () => {};
    return { installer, registered, removeSkills };
  });
  const remove = (): void => {
    const sweep = sweepWorkerServices({ ...deps.worker, mycoHome: home }, { onlyThisHome: true });
    for (const unit of sweep.kept) console.log(`Preserved ${unit.unitFile}: ${unit.reason}`);
    for (const { installer, registered, removeSkills } of registrations) {
      if (registered) installer.uninstallMemberRegistration();
      removeSkills();
    }
    if (purge && fs.existsSync(home)) {
      for (const entry of fs.readdirSync(home)) {
        if (losses.length > 0 && entry === 'server') {
          const server = path.join(home, entry);
          for (const file of fs.readdirSync(server)) {
            if (!DEPLOYMENT_LEASE_FILES.includes(file)) fs.rmSync(path.join(server, file), { recursive: true, force: true });
          }
        } else fs.rmSync(path.join(home, entry), { recursive: true, force: true });
      }
    }
  };
  // Serving and provisioning hold these same leases for their entire operation.
  if (purge && losses.length > 0) {
    withCloudflareOperation(home, () => {
      const local = path.join(home, 'server', 'local');
      if (fs.existsSync(local)) new LocalVolume(resolveLocalPaths(home)).exclusive(remove);
      else remove();
    });
  } else remove();
  if (purge && fs.existsSync(home)) {
    const server = path.join(home, 'server');
    if (losses.length > 0) {
      for (const file of DEPLOYMENT_LEASE_FILES) fs.rmSync(path.join(server, file), { force: true });
      fs.rmdirSync(server);
    }
    fs.rmdirSync(home);
  }
  console.log(purge ? `Purged member home ${home}.` : `Member install removed; preserved data at ${home}.`);
  if (purge && process.platform === 'win32') console.log('Preserved the shared Windows managed binary and versions outside this home; other Myco homes may use them.');
}
