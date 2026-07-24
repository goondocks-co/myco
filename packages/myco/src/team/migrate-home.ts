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
        fs.cpSync(sourcePath, destinationPath, { recursive: true });
        filled = true;
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (!fs.existsSync(destinationPath)) {
      fs.copyFileSync(sourcePath, destinationPath);
      filled = true;
      continue;
    }
    if (filesEqual(sourcePath, destinationPath)) continue;
    const backupPath = destinationPath + BAK_SUFFIX;
    if (fs.existsSync(backupPath)) {
      if (!filesEqual(sourcePath, backupPath)) {
        throw new Error(`Refusing to overwrite divergent legacy Team backup: ${backupPath}`);
      }
    } else {
      fs.copyFileSync(sourcePath, backupPath);
    }
    conflicted = true;
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

  fs.mkdirSync(destTeamsDir, { recursive: true });
  const tempRedirect = `${legacyTeamsDir}.redirect-${process.pid}-${randomBytes(12).toString('hex')}`;
  let archived = false;
  try {
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
  if (existing === undefined) return;
  if (existing.isSymbolicLink()) {
    if (pathsEquivalent(legacyTeamsDir, destTeamsDir)) return;
    throw new Error(`Legacy Team redirect points somewhere unexpected: ${legacyTeamsDir}`);
  }
  if (!existing.isDirectory()) {
    throw new Error(`Legacy Team path is not a directory: ${legacyTeamsDir}`);
  }

  const entries = fs.readdirSync(legacyTeamsDir, { withFileTypes: true });
  if (entries.some((entry) => !entry.isDirectory())) {
    throw new Error(`Legacy Team home contains an unsupported top-level entry: ${legacyTeamsDir}`);
  }
  const migrations: TeamMigration[] = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const sourceDir = path.join(legacyTeamsDir, entry.name);
      const destinationDir = path.join(destTeamsDir, entry.name);
      assertExistingRealDirectory(sourceDir, 'Legacy Team source');
      return {
        name: entry.name,
        sourceDir,
        destinationDir,
        destinationExisted: assertOptionalRealDirectory(destinationDir, 'Canonical Team destination'),
      };
    });
  const pairs = migrations.map((migration) => ({
    sourceVaultDir: migration.sourceDir,
    destinationVaultDir: migration.destinationDir,
  }));

  const firstPass = withLegacyTeamSecretSnapshotsReconciledSync(pairs, () => 'complete');
  migrations.forEach((migration, index) => {
    const files = reconcileTeamDir(migration.sourceDir, migration.destinationDir);
    if (!verifyCopied(migration.sourceDir, migration.destinationDir)) {
      throw new Error(`Legacy Team verification failed: ${migration.name}`);
    }
    recordDisposition(result, migration.name, combinedDisposition(migration, files, firstPass.dispositions[index]!));
  });

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
    if (pathsEquivalent(legacyTeamsDir, destTeamsDir)) continue;
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
