import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import {
  SECRETS_FILE,
  withLegacyTeamSecretSnapshotsReconciledSync,
  type LegacyTeamSecretDisposition,
} from '@myco/config/secrets.js';
import { pathsEquivalent, resolveTeamsDir, TEAMS_DIRNAME } from '@myco/grove/paths.js';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';
import { resolvePerUserLocksDir } from '@myco/utils/user-lock-root.js';

const BAK_SUFFIX = '.bak-pre-myco-team';
const MYCO_TEAM_LEGACY_HOMES_ENV = 'MYCO_TEAM_LEGACY_HOMES';
const OWNER_ONLY_FILE_MODE = 0o600;
const OWNER_ONLY_DIR_MODE = 0o700;

export interface MigrateTeamsResult {
  copied: string[]; gapFilled: string[]; conflicted: string[]; retiredHomes: string[];
}

type Disposition = 'copied' | 'gapFilled' | 'conflicted' | 'noop';

interface TeamMigration {
  name: string;
  sourceDir: string;
  destinationDir: string;
  destinationExisted: boolean;
}

/**
 * Legacy machine homes to sweep. Passed explicitly because Bun's
 * os.homedir() ignores HOME changes made after process launch.
 */
export function defaultLegacyTeamHomes(homeDir: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env[MYCO_TEAM_LEGACY_HOMES_ENV];
  if (override !== undefined) {
    const trimmed = override.trim();
    return trimmed === '' ? [] : trimmed.split(path.delimiter).map((h) => path.resolve(h.trim())).filter(Boolean);
  }
  const homes = [path.join(homeDir, '.myco'), path.join(homeDir, '.myco-dev')];
  const current = env.MYCO_HOME?.trim();
  if (current) homes.push(path.resolve(current));
  return homes;
}

function filesEqual(a: string, b: string): boolean {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

function ownerOnlyRegularFile(pathname: string): boolean {
  try {
    const stat = fs.lstatSync(pathname);
    return stat.isFile() && !stat.isSymbolicLink()
      && (process.platform === 'win32' || (stat.mode & 0o777) === OWNER_ONLY_FILE_MODE);
  } catch {
    return false;
  }
}

function assertExistingRealDirectory(target: string, label: string): void {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a real directory: ${target}`);
  }
}

function assertOptionalRealDirectory(target: string, label: string): boolean {
  const stat = lstatOrUndefined(target);
  if (stat === undefined) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a real directory: ${target}`);
  }
  return true;
}

function ensureRealDirectory(target: string, label: string): void {
  if (!assertOptionalRealDirectory(target, label)) {
    fs.mkdirSync(target, { recursive: true });
    assertExistingRealDirectory(target, label);
  }
}

function copyFileExclusive(sourcePath: string, destinationPath: string): boolean {
  try {
    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function reconcileRegularFile(
  sourcePath: string,
  destinationPath: string,
): { filled: boolean; conflicted: boolean } {
  if (copyFileExclusive(sourcePath, destinationPath)) {
    return { filled: true, conflicted: false };
  }
  if (filesEqual(sourcePath, destinationPath)) {
    return { filled: false, conflicted: false };
  }
  const backupPath = destinationPath + BAK_SUFFIX;
  if (!copyFileExclusive(sourcePath, backupPath) && !filesEqual(sourcePath, backupPath)) {
    throw new Error(`Refusing to overwrite divergent legacy Team backup: ${backupPath}`);
  }
  return { filled: false, conflicted: true };
}

/**
 * Fill missing files and subdirectories into dst. Destination content wins;
 * divergent legacy files are retained beside it under the fixed backup suffix.
 */
function reconcileTeamDir(src: string, dst: string): { filled: boolean; conflicted: boolean } {
  assertExistingRealDirectory(src, 'Legacy Team source');
  ensureRealDirectory(dst, 'Canonical Team destination');
  let filled = false;
  let conflicted = false;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sourcePath = path.join(src, entry.name);
    const destinationPath = path.join(dst, entry.name);
    if (entry.name === SECRETS_FILE) continue;
    if (entry.isDirectory()) {
      if (!fs.existsSync(destinationPath)) {
        fs.cpSync(sourcePath, destinationPath, {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
        filled = true;
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const outcome = reconcileRegularFile(sourcePath, destinationPath);
    filled ||= outcome.filled;
    conflicted ||= outcome.conflicted;
  }
  return { filled, conflicted };
}

/**
 * Every root file is present at dst or in its retained backup, and every
 * legacy subtree has a destination-owned counterpart. Retirement retains the
 * complete legacy tree under the home-level backup.
 */
function verifyCopied(src: string, dst: string): boolean {
  try {
    assertExistingRealDirectory(src, 'Legacy Team source');
    assertExistingRealDirectory(dst, 'Canonical Team destination');
  } catch {
    return false;
  }
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sourcePath = path.join(src, entry.name);
    const destinationPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(destinationPath)) return false;
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === SECRETS_FILE) {
      if (!ownerOnlyRegularFile(destinationPath)) return false;
      if (filesEqual(sourcePath, destinationPath)) continue;
      const backupPath = destinationPath + BAK_SUFFIX;
      if (!ownerOnlyRegularFile(backupPath) || !filesEqual(sourcePath, backupPath)) return false;
      continue;
    }
    if (!fs.existsSync(destinationPath)) return false;
    if (!filesEqual(sourcePath, destinationPath) && !filesEqual(sourcePath, destinationPath + BAK_SUFFIX)) return false;
  }
  return true;
}

function topologyLockPath(legacyTeamsDir: string): string {
  const lockDir = path.join(resolvePerUserLocksDir(), 'legacy-team-home');
  fs.mkdirSync(lockDir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  try { fs.chmodSync(lockDir, OWNER_ONLY_DIR_MODE); } catch { /* platform ACLs apply */ }
  const identity = process.platform === 'win32'
    ? path.resolve(legacyTeamsDir).toLowerCase()
    : path.resolve(legacyTeamsDir);
  return path.join(lockDir, `${createHash('sha256').update(identity).digest('hex')}.lock`);
}

function lstatOrUndefined(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function createVerifiedRedirect(tempPath: string, destination: string): void {
  const absoluteDestination = path.resolve(destination);
  try {
    fs.symlinkSync(absoluteDestination, tempPath, 'dir');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES') throw error;
    fs.symlinkSync(absoluteDestination, tempPath, 'junction');
  }
  if (!fs.lstatSync(tempPath).isSymbolicLink() || !pathsEquivalent(tempPath, absoluteDestination)) {
    throw new Error(`Legacy Team redirect did not resolve to canonical teams directory: ${tempPath}`);
  }
}

function removeOwnedTemporaryRedirect(tempPath: string): void {
  try {
    if (fs.lstatSync(tempPath).isSymbolicLink()) fs.unlinkSync(tempPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function verifiedTemporaryRedirects(legacyTeamsDir: string, destTeamsDir: string): string[] {
  const parent = path.dirname(legacyTeamsDir);
  const prefix = `${path.basename(legacyTeamsDir)}.redirect-`;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => path.join(parent, entry.name))
    .map((candidate) => {
      const stat = fs.lstatSync(candidate);
      if (!stat.isSymbolicLink() || !pathsEquivalent(candidate, destTeamsDir)) {
        throw new Error(`Refusing unexpected legacy Team redirect staging path: ${candidate}`);
      }
      return candidate;
    })
    .sort();
}

function temporaryRedirectPath(legacyTeamsDir: string): string {
  return `${legacyTeamsDir}.redirect-${process.pid}-${randomBytes(12).toString('hex')}`;
}

function claimLegacyTeamsRedirect(
  legacyTeamsDir: string,
  destTeamsDir: string,
  reusableRedirects: readonly string[] = [],
): string[] {
  fs.mkdirSync(destTeamsDir, { recursive: true });
  const tempRedirect = reusableRedirects[0]
    ?? temporaryRedirectPath(legacyTeamsDir);
  const recoveryRedirects = reusableRedirects.slice(1);
  let published = false;
  try {
    if (recoveryRedirects.length === 0) {
      const recoveryRedirect = temporaryRedirectPath(legacyTeamsDir);
      recoveryRedirects.push(recoveryRedirect);
      createVerifiedRedirect(recoveryRedirect, destTeamsDir);
    }
    if (reusableRedirects.length === 0) createVerifiedRedirect(tempRedirect, destTeamsDir);
    fs.renameSync(tempRedirect, legacyTeamsDir);
    published = true;
    if (!fs.lstatSync(legacyTeamsDir).isSymbolicLink() || !pathsEquivalent(legacyTeamsDir, destTeamsDir)) {
      throw new Error(`Legacy Team redirect publication failed: ${legacyTeamsDir}`);
    }
    return recoveryRedirects;
  } catch (error) {
    removeOwnedTemporaryRedirect(tempRedirect);
    if (!published) recoveryRedirects.forEach(removeOwnedTemporaryRedirect);
    throw error;
  }
}

/**
 * Publish the durable redirect after the source tree is fully accounted for.
 * The temporary link is verified before the source rename, and rollback never
 * removes a path recreated by another writer.
 */
function retireLegacyTeamsDir(
  legacyTeamsDir: string,
  destTeamsDir: string,
  migrations: readonly TeamMigration[],
): void {
  const archivePath = legacyTeamsDir + BAK_SUFFIX;
  if (lstatOrUndefined(archivePath) !== undefined) {
    throw new Error(`Legacy Team archive already exists: ${archivePath}`);
  }

  const tempRedirect = `${legacyTeamsDir}.redirect-${process.pid}-${randomBytes(12).toString('hex')}`;
  let archived = false;
  try {
    fs.mkdirSync(destTeamsDir, { recursive: true });
    createVerifiedRedirect(tempRedirect, destTeamsDir);
    fs.renameSync(legacyTeamsDir, archivePath);
    archived = true;

    const archivedEntries = fs.readdirSync(archivePath, { withFileTypes: true });
    const archivedNames = archivedEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const plannedNames = migrations.map((migration) => migration.name).sort();
    if (archivedEntries.some((entry) => !entry.isDirectory())
      || archivedNames.length !== plannedNames.length
      || archivedNames.some((name, index) => name !== plannedNames[index])) {
      throw new Error(`Legacy Team topology changed during migration: ${legacyTeamsDir}`);
    }

    for (const migration of migrations) {
      const archivedSource = path.join(archivePath, migration.name);
      reconcileTeamDir(archivedSource, migration.destinationDir);
      if (!verifyCopied(archivedSource, migration.destinationDir)) {
        throw new Error(`Legacy Team verification failed after archive: ${migration.name}`);
      }
    }

    fs.renameSync(tempRedirect, legacyTeamsDir);
    if (!fs.lstatSync(legacyTeamsDir).isSymbolicLink() || !pathsEquivalent(legacyTeamsDir, destTeamsDir)) {
      throw new Error(`Legacy Team redirect publication failed: ${legacyTeamsDir}`);
    }
  } catch (error) {
    removeOwnedTemporaryRedirect(tempRedirect);
    if (archived && lstatOrUndefined(legacyTeamsDir) === undefined) {
      fs.renameSync(archivePath, legacyTeamsDir);
    }
    throw error;
  }
}

function planTeamMigrations(sourceTeamsDir: string, destTeamsDir: string): TeamMigration[] {
  assertExistingRealDirectory(sourceTeamsDir, 'Legacy Team source home');
  const entries = fs.readdirSync(sourceTeamsDir, { withFileTypes: true });
  if (entries.some((entry) => !entry.isDirectory())) {
    throw new Error(`Legacy Team home contains an unsupported top-level entry: ${sourceTeamsDir}`);
  }
  return entries.map((entry) => {
    const sourceDir = path.join(sourceTeamsDir, entry.name);
    const destinationDir = path.join(destTeamsDir, entry.name);
    assertExistingRealDirectory(sourceDir, 'Legacy Team source');
    return {
      name: entry.name,
      sourceDir,
      destinationDir,
      destinationExisted: assertOptionalRealDirectory(destinationDir, 'Canonical Team destination'),
    };
  });
}

function migrationSecretPairs(migrations: readonly TeamMigration[]) {
  return migrations.map((migration) => ({
    sourceVaultDir: migration.sourceDir,
    destinationVaultDir: migration.destinationDir,
  }));
}

function reconcileTeamMigrations(
  migrations: readonly TeamMigration[],
  result: MigrateTeamsResult,
): void {
  const firstPass = withLegacyTeamSecretSnapshotsReconciledSync(
    migrationSecretPairs(migrations),
    () => 'complete',
  );
  migrations.forEach((migration, index) => {
    const files = reconcileTeamDir(migration.sourceDir, migration.destinationDir);
    if (!verifyCopied(migration.sourceDir, migration.destinationDir)) {
      throw new Error(`Legacy Team verification failed: ${migration.name}`);
    }
    recordDisposition(result, migration.name, combinedDisposition(migration, files, firstPass.dispositions[index]!));
  });
}

function recoverArchivedLegacyTeamsDir(
  legacyTeamsDir: string,
  destTeamsDir: string,
  result: MigrateTeamsResult,
  publishedRedirect = false,
): void {
  const archivePath = legacyTeamsDir + BAK_SUFFIX;
  const reusableRedirects = verifiedTemporaryRedirects(legacyTeamsDir, destTeamsDir);
  const migrations = planTeamMigrations(archivePath, destTeamsDir);
  const recoveryRedirects = publishedRedirect
    ? reusableRedirects
    : claimLegacyTeamsRedirect(legacyTeamsDir, destTeamsDir, reusableRedirects);
  reconcileTeamMigrations(migrations, result);

  const finalPass = withLegacyTeamSecretSnapshotsReconciledSync(
    migrationSecretPairs(migrations),
    () => {
      if (!migrations.every((migration) => verifyCopied(migration.sourceDir, migration.destinationDir))) {
        return 'deferred';
      }
      return 'complete';
    },
  );
  if (finalPass.outcome === 'complete') {
    recoveryRedirects.forEach(removeOwnedTemporaryRedirect);
    result.retiredHomes.push(legacyTeamsDir);
  }
}

function combinedDisposition(
  migration: TeamMigration,
  files: { filled: boolean; conflicted: boolean },
  secrets: LegacyTeamSecretDisposition,
): Disposition {
  if (files.conflicted || secrets === 'conflicted') return 'conflicted';
  if (!migration.destinationExisted) return 'copied';
  if (files.filled || secrets === 'copied') return 'gapFilled';
  return 'noop';
}

function recordDisposition(result: MigrateTeamsResult, name: string, disposition: Disposition): void {
  if (disposition === 'copied') result.copied.push(name);
  else if (disposition === 'gapFilled') result.gapFilled.push(name);
  else if (disposition === 'conflicted') result.conflicted.push(name);
}

function migrateLegacyTeamsDir(
  legacyTeamsDir: string,
  destTeamsDir: string,
  result: MigrateTeamsResult,
): void {
  const existing = lstatOrUndefined(legacyTeamsDir);
  const archivePath = legacyTeamsDir + BAK_SUFFIX;
  const archive = lstatOrUndefined(archivePath);
  if (existing !== undefined
    && !existing.isSymbolicLink()
    && pathsEquivalent(legacyTeamsDir, destTeamsDir)) {
    return;
  }
  if (existing === undefined) {
    if (archive === undefined) return;
    recoverArchivedLegacyTeamsDir(legacyTeamsDir, destTeamsDir, result);
    return;
  }
  if (existing.isSymbolicLink()) {
    if (pathsEquivalent(legacyTeamsDir, destTeamsDir)) {
      if (archive !== undefined
        && verifiedTemporaryRedirects(legacyTeamsDir, destTeamsDir).length > 0) {
        recoverArchivedLegacyTeamsDir(legacyTeamsDir, destTeamsDir, result, true);
      }
      return;
    }
    throw new Error(`Legacy Team redirect points somewhere unexpected: ${legacyTeamsDir}`);
  }
  if (archive !== undefined) {
    throw new Error(`Legacy Team archive already exists: ${archivePath}`);
  }
  if (!existing.isDirectory()) {
    throw new Error(`Legacy Team path is not a directory: ${legacyTeamsDir}`);
  }

  const migrations = planTeamMigrations(legacyTeamsDir, destTeamsDir);
  const pairs = migrationSecretPairs(migrations);
  reconcileTeamMigrations(migrations, result);

  const finalPass = withLegacyTeamSecretSnapshotsReconciledSync(pairs, () => {
    if (!migrations.every((migration) => verifyCopied(migration.sourceDir, migration.destinationDir))) {
      return 'deferred';
    }
    retireLegacyTeamsDir(legacyTeamsDir, destTeamsDir, migrations);
    return 'complete';
  });
  if (finalPass.outcome === 'complete') result.retiredHomes.push(legacyTeamsDir);
}

export function migrateTeamsHomeIfNeeded(legacyHomes: string[] = defaultLegacyTeamHomes()): MigrateTeamsResult {
  const result: MigrateTeamsResult = { copied: [], gapFilled: [], conflicted: [], retiredHomes: [] };
  const destTeamsDir = resolveTeamsDir();
  const seen = new Set<string>();

  for (const home of legacyHomes) {
    const legacyTeamsDir = path.join(home, TEAMS_DIRNAME);
    const key = process.platform === 'win32'
      ? path.resolve(legacyTeamsDir).toLowerCase()
      : path.resolve(legacyTeamsDir);
    if (seen.has(key)) continue;
    seen.add(key);
    withFileLockSync(topologyLockPath(legacyTeamsDir), () => {
      migrateLegacyTeamsDir(legacyTeamsDir, destTeamsDir, result);
    });
  }

  return result;
}
