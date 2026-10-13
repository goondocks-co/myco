import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { resolveMycoHome, resolveHomeDir, canonicalHomePath } from '../paths/home.js';
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
import { legacyMigrationState } from '../member/legacy-migration.js';
import { defaultSpec, serviceHomeOwnership, statusOfService } from '../server/service.js';
import { listRunnerRecords } from '../runner/runner-registry.js';

export const USAGE = `Usage: myco remove [--purge] [--allow-deployment-loss] [--yes]

Remove this home's global member hooks, MCP registrations and skill links,
and its worker and runner services. Repository files and Myco 1.4 homes
are preserved. Member credentials and captured data stay unless --purge is passed.
Shared Windows binaries outside this home stay installed.

Options:
  --purge                  Delete only owned 2.0 entries; preserve 1.4 and unknown files
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
export const MEMBER_HOME_PURGE_ENTRIES = [
  'member', 'skills', 'bin', 'install.json', 'runtime.command', 'runtime.home', 'logs', 'runner', 'worker', 'server', 'installer-audit',
] as const;
const DEPLOYMENT_LEASE_FILES = ['cloudflare.lock', 'local.lock'];

function assertPurgeHome(home: string): void {
  const target = canonicalHomePath(path.resolve(home));
  const userHomes = [resolveHomeDir(), homedir()].map(canonicalHomePath);
  const containsUser = userHomes.some(user => {
    const relative = path.relative(target, user);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  });
  if (target === path.parse(target).root || containsUser
    || target === canonicalHomePath(process.cwd())) {
    throw new Error(`Refusing --purge of ${home}: it is the user home, an ancestor of it, a filesystem root or the current directory. No files were removed.`);
  }
  if ([home, path.join(home, 'server'), path.join(home, 'member')].some(file => fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())) {
    throw new Error('Refusing --purge of a symlinked home, member or Deployment directory; no files were removed.');
  }
}

function assertServerUninstalled(home: string, deps: WorkerServiceDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  const spec = defaultSpec(deps.binaryPath ?? process.execPath, deps.home ?? resolveHomeDir(), platform, home);
  const options = { platform, runner: deps.runner };
  const ownership = serviceHomeOwnership(spec, options);
  if (ownership === 'foreign') return;
  if (ownership === 'unknown') throw new Error('Cannot establish which home the native Deployment service serves; reconcile its service before purge.');
  const installed = ownership === 'same';
  const task = !installed && platform === 'win32' ? statusOfService(spec, { ...options, inspectMissing: true }) : null;
  if (task?.detail === "the platform's service manager could not be run") {
    throw new Error('Cannot inspect the native Deployment scheduled task; purge aborted.');
  }
  if (installed || task?.loaded) throw new Error(`Refusing --purge while a native Deployment service is installed. Run \`myco server uninstall --target local\` with MYCO_HOME=${home} first; stopping it leaves the installed service in place.`);
}

/** Existing paths whose loss requires separate, explicit consent. */
export function deploymentLosses(home: string): string[] {
  const losses: string[] = [];
  const server = path.join(home, 'server');
  if (fs.existsSync(server)) {
    losses.push(`Deployment files at ${server} (all retained contents, including any databases, object storage, configuration and credentials).`);
    if (fs.existsSync(path.join(server, 'local'))) losses.push('Back up the local Deployment outside this home with `myco server backup --target local --to <backup-dir>`.');
  }
  for (const record of [path.join(server, 'cloudflare', 'record.json'), path.join(server, 'cloudflare.json')]) {
    if (fs.existsSync(record)) losses.push(`Cloudflare operator record at ${record} (Deployment resource identities and recovery metadata). `
      + 'Back up the Deployment with `myco server backup --target cloudflare --to <backup-dir>`. '
      + "Copy this record into another home's server/cloudflare/record.json, or re-adopt later with `myco server create --target cloudflare --account-id <id>`.");
  }
  return losses;
}

function legacyPreservation(home: string, entries: readonly string[]): string | null {
  if (entries.length === 0) return null;
  const state = legacyMigrationState(home);
  const kept = entries.map(entry => path.join(home, entry)).join(', ');
  return `Your 1.4 files remain at ${kept}; check backups/cutover-* before deleting them by hand.`
    + (state.state === 'unmoved' ? ` ${LEGACY_MIGRATION_GUIDANCE}` : state.state === 'unavailable' ? ` Migration status unavailable: ${state.detail}` : '');
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
  if (purge) {
    assertPurgeHome(home);
    assertServerUninstalled(home, deps.worker);
  }
  const entries = fs.existsSync(home) ? fs.readdirSync(home).sort() : [];
  const legacy = entries.filter(entry => LEGACY_HOME_ENTRIES.includes(entry));
  const legacyMessage = legacyPreservation(home, legacy);
  if (purge && !isMemberHome(home) && (legacy.length > 0 || legacyVaultFiles(home).length > 0)) {
    console.error(`Refusing --purge of a Myco 1.4 home at ${home}. ${legacyMessage ?? LEGACY_MIGRATION_GUIDANCE}`);
    process.exitCode = 1;
    return;
  }
  const preserveReceipt = legacy.length > 0 && fs.existsSync(path.join(home, 'member', 'cutover.json'));
  const deletions = entries.filter(entry => MEMBER_HOME_PURGE_ENTRIES.some(owned => owned === entry)).flatMap(entry =>
    entry === 'member' && preserveReceipt
      ? fs.readdirSync(path.join(home, entry)).filter(file => file !== 'cutover.json').map(file => path.join(entry, file))
      : [entry]);
  const losses = deploymentLosses(home);
  if (purge && deletions.length > 0 && !isMemberHome(home) && listRunnerRecords(home).length === 0 && losses.length === 0) {
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
    + (purge ? `Delete only these 2.0 entries (including member credentials and buffered capture):\n${deletions.map(entry => `DELETE ${path.join(home, entry)}`).join('\n')}\n${losses.join('\n')}` : `Preserve data at ${home}.`);
  if (!parsed.has('--yes') && !await (deps.confirm ?? confirmDestructive)(summary)) {
    console.error('Aborted — nothing was removed.');
    process.exitCode = 1;
    return;
  }
  const provision = readProvisionRecord(home);
  const memberOwned = isMemberHome(home) || provision !== null;
  const deployment = provision?.serverUrl ?? readDefaultDeployment(home)?.serverUrl ?? null;
  const registrations = loadManifests().map(manifest => {
    const installer = new SymbiontInstaller(manifest, home, resolvePackageRoot(), false, undefined, null, 'member-global', home).withoutProjectRoot();
    if (deployment !== null) installer.forDeployment(deployment);
    const hooks = installer.inspectMemberHooks();
    const mcp = installer.inspectMemberMcp();
    if (!hooks.readable || mcp.some(entry => !entry.readable)) throw new Error(`Cannot read ${manifest.displayName}'s member registration; removal aborted.`);
    const registered = hooks.member || mcp.some(entry => entry.carriesCredential);
    if (registered) installer.assertMemberUninstallable();
    const target = manifest.registration?.globalSkillsTarget;
    const removeSkills = target && (memberOwned || registered) ? prepareMemberSkillRemoval(home, skillsFolder(target)) : () => {};
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
      for (const entry of deletions) {
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
    if (fs.readdirSync(home).length === 0) fs.rmdirSync(home);
  }
  if (purge && preserveReceipt) console.log(`Preserved migration receipt at ${path.join(home, 'member', 'cutover.json')}.`);
  if (legacyMessage) console.log(legacyMessage);
  if (purge && fs.existsSync(home)) console.log(`Preserved entries at ${home}: ${fs.readdirSync(home).join(', ')}`);
  console.log(purge ? `Purged owned 2.0 entries at ${home}.` : `Member install removed; preserved data at ${home}.`);
  if (purge && process.platform === 'win32') console.log('Preserved the shared Windows managed binary and versions outside this home; other Myco homes may use them.');
}
