import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { resolveMycoHome, resolveHomeDir, canonicalHomePath, defaultMycoHome } from '../paths/home.js';
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
import { readInstallMarker } from '../install/managed-binary.js';

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
  'member', 'skills', 'bin', 'install.json', 'runtime.command', 'runtime.home', 'logs', 'runner', 'worker', 'server', 'installer-audit', 'setup.json', 'last-update-check.json',
] as const;
const DEPLOYMENT_LEASE_FILES = ['cloudflare.lock', 'local.lock'];

const purgePathKey = (file: string, platform = process.platform): string =>
  platform === 'win32' ? path.win32.resolve(file).toLowerCase() : path.resolve(file);

/** Home, ancestor, root and cwd refusal using the target platform's path semantics. */
export function unsafePurgePath(target: string, userHomes: readonly string[], cwd: string, platform = process.platform): boolean {
  const paths = platform === 'win32' ? path.win32 : path;
  const key = purgePathKey(target, platform);
  const containsUser = userHomes.some(user => {
    const relative = paths.relative(key, purgePathKey(user, platform));
    return relative === '' || (!relative.startsWith(`..${paths.sep}`) && relative !== '..' && !paths.isAbsolute(relative));
  });
  return key === purgePathKey(paths.parse(key).root, platform) || containsUser || key === purgePathKey(cwd, platform);
}

function assertPurgeHome(home: string): string {
  const target = canonicalHomePath(path.resolve(home));
  const userHomes = [resolveHomeDir(), homedir()].map(canonicalHomePath);
  if (unsafePurgePath(target, userHomes, canonicalHomePath(process.cwd()))) {
    throw new Error(`Refusing --purge of ${home}: it is the user home, an ancestor of it, a filesystem root or the current directory. This path will not be purged.`);
  }
  if ([home, path.join(home, 'server'), path.join(home, 'member')].some(file => fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())) {
    throw new Error('Refusing --purge of a symlinked home, member or Deployment directory; this path will not be purged.');
  }
  return target;
}

function assertDedicatedHome(home: string, deletions: readonly string[]): void {
  if (deletions.length === 0 || purgePathKey(home) === purgePathKey(canonicalHomePath(defaultMycoHome()))) return;
  const marker = fs.lstatSync(path.join(home, 'install.json'), { throwIfNoEntry: false });
  if (marker?.isFile() && readInstallMarker(home, true) !== null) return;
  throw new Error(`Refusing --purge: ${home} is not the default home and has no install.json marking a dedicated Myco home. Would delete:
${deletions.map(entry => path.join(home, entry)).join('\n')}`);
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
  const retained = `Your 1.4 files remain at ${kept}.`;
  if (state.state === 'moved') return `${retained} Check backups/cutover-* before deleting them by hand.`;
  const detail = state.state === 'changed' ? ` ${state.warning}`
    : state.state === 'unavailable' ? ` Migration status unavailable: ${state.detail}` : '';
  const guidance = state.state === 'unmoved' ? LEGACY_MIGRATION_GUIDANCE : 'Run `myco cutover --dry-run` to review the remaining migration work, then `myco cutover`.';
  return `${retained}${detail} ${guidance}`;
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
  const canonical = purge ? assertPurgeHome(home) : home;
  const checkedIdentity = purge ? fs.lstatSync(canonical, { bigint: true, throwIfNoEntry: false }) : undefined;
  const assertUnchangedHome = (): void => {
    if (!purge) return;
    const current = assertPurgeHome(home);
    const identity = fs.lstatSync(canonical, { bigint: true, throwIfNoEntry: false });
    if (purgePathKey(current) !== purgePathKey(canonical)
      || identity?.dev !== checkedIdentity?.dev || identity?.ino !== checkedIdentity?.ino) {
      throw new Error('Refusing --purge: the canonical home changed after its deletion plan was checked. Deletion stopped.');
    }
  };
  if (purge) assertServerUninstalled(home, deps.worker);
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
  if (purge) assertDedicatedHome(canonical, deletions);
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
  assertUnchangedHome();
  if (purge) {
    assertDedicatedHome(canonical, deletions);
    assertServerUninstalled(home, deps.worker);
  }
  const removeEntry = (relative: string, recursive = true): void => {
    assertUnchangedHome();
    let parent = canonical;
    for (const part of relative.split(path.sep).slice(0, -1)) {
      parent = path.join(parent, part);
      const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
      if (stat === undefined) return;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing --purge through a changed parent at ${parent}.`);
    }
    const file = path.join(canonical, relative);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) fs.unlinkSync(file);
    else if (stat !== undefined) fs.rmSync(file, { recursive, force: true });
  };
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
    assertUnchangedHome();
    const sweep = sweepWorkerServices({ ...deps.worker, mycoHome: home }, { onlyThisHome: true });
    for (const unit of sweep.kept) console.log(`Preserved ${unit.unitFile}: ${unit.reason}`);
    for (const { installer, registered, removeSkills } of registrations) {
      if (registered) installer.uninstallMemberRegistration();
      removeSkills();
    }
    if (purge && fs.existsSync(canonical)) {
      for (const entry of deletions) {
        if (losses.length > 0 && entry === 'server') {
          const server = path.join(canonical, entry);
          for (const file of fs.readdirSync(server)) {
            if (!DEPLOYMENT_LEASE_FILES.includes(file)) removeEntry(path.join(entry, file));
          }
        } else removeEntry(entry);
      }
    }
  };
  // Serving and provisioning hold these same leases for their entire operation.
  if (purge && losses.length > 0) {
    withCloudflareOperation(canonical, () => {
      const local = path.join(canonical, 'server', 'local');
      if (fs.existsSync(local)) new LocalVolume(resolveLocalPaths(canonical)).exclusive(remove);
      else remove();
    });
  } else remove();
  if (purge && fs.existsSync(canonical)) {
    assertUnchangedHome();
    const server = path.join(canonical, 'server');
    if (losses.length > 0) {
      for (const file of DEPLOYMENT_LEASE_FILES) removeEntry(path.join('server', file), false);
      fs.rmdirSync(server);
    }
    if (fs.readdirSync(canonical).length === 0) fs.rmdirSync(canonical);
  }
  if (purge && preserveReceipt) console.log(`Preserved migration receipt at ${path.join(home, 'member', 'cutover.json')}.`);
  if (legacyMessage) console.log(legacyMessage);
  if (purge && fs.existsSync(home)) console.log(`Preserved entries at ${home}: ${fs.readdirSync(home).join(', ')}`);
  console.log(purge ? `Purged owned 2.0 entries at ${home}.` : `Member install removed; preserved data at ${home}.`);
  if (purge && process.platform === 'win32') console.log('Preserved the shared Windows managed binary and versions outside this home; other Myco homes may use them.');
}
