import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  reconcileSecretFile,
  readSecretsFile,
  secretFilesEqual,
  SECRETS_FILE,
  tightenSecretSnapshotPermissions,
  tightenSecretsPermissions,
  withReconciledSecretFiles,
} from '../config/secrets.js';
import { pathsEquivalent, resolveTeamsDir, TEAMS_DIRNAME } from '../grove/paths.js';

const BAK_SUFFIX = '.bak-pre-myco-team';

const MYCO_TEAM_LEGACY_HOMES_ENV = 'MYCO_TEAM_LEGACY_HOMES';

export interface MigrateTeamsResult {
  copied: string[]; gapFilled: string[]; conflicted: string[]; retiredHomes: string[];
}

type Disposition = 'copied' | 'gapFilled' | 'conflicted' | 'noop';

/**
 * Legacy machine homes to sweep. Passed explicitly (NOT recomputed from $HOME:
 * Bun's os.homedir() ignores $HOME set after launch). Honors the
 * MYCO_TEAM_LEGACY_HOMES env override for test hermeticity: when set, ONLY the
 * listed (path.delimiter-separated) homes are scanned, and an empty string means
 * "scan nothing" — this is how the test runner stops a test that boots
 * initTeamSync from sweeping the developer's real ~/.myco. Unset (production):
 * the known sibling homes plus the current MYCO_HOME.
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

function ownerOnly(pathname: string): boolean {
  return process.platform === 'win32' || (fs.statSync(pathname).mode & 0o777) === 0o600;
}

/** Validate every secret input before a migration writes any destination team. */
function preflightTeamSecrets(entries: fs.Dirent[], legacyTeamsDir: string, destTeamsDir: string): void {
  const sourceDirs: string[] = [];
  const destinationDirs: string[] = [];
  const backupDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceDir = path.join(legacyTeamsDir, entry.name);
    const destinationDir = path.join(destTeamsDir, entry.name);
    const sourcePath = path.join(sourceDir, SECRETS_FILE);
    const destinationPath = path.join(destinationDir, SECRETS_FILE);
    const backupPath = destinationPath + BAK_SUFFIX;
    if (fs.existsSync(sourcePath)) {
      readSecretsFile(sourcePath);
      sourceDirs.push(sourceDir);
    }
    if (fs.existsSync(destinationPath)) {
      readSecretsFile(destinationPath);
      destinationDirs.push(destinationDir);
    }
    if (fs.existsSync(backupPath)) {
      readSecretsFile(backupPath);
      backupDirs.push(destinationDir);
    }
  }

  // The legacy tree is retained as a backup after migration. Tighten only
  // after every source and destination passed decoding, never on malformed data.
  for (const sourceDir of sourceDirs) tightenSecretsPermissions(sourceDir);
  for (const destinationDir of destinationDirs) tightenSecretsPermissions(destinationDir);
  for (const destinationDir of backupDirs) {
    tightenSecretSnapshotPermissions(destinationDir, SECRETS_FILE + BAK_SUFFIX);
  }
}

/**
 * Fill missing files/subdirs into dst; archive (never overwrite) a divergent file. Dest wins.
 * A team dir is NOT flat: it holds the `worker` deploy subdir (wrangler source + node_modules
 * + cached account binding). Subdirs are copied as a whole subtree when absent at dst.
 */
function reconcileTeamDir(src: string, dst: string): Disposition {
  const existed = fs.existsSync(dst);
  fs.mkdirSync(dst, { recursive: true });
  let filled = false, conflicted = false;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sf = path.join(src, entry.name), df = path.join(dst, entry.name);
    if (entry.name === SECRETS_FILE) continue;
    if (entry.isDirectory()) {
      // Copy the whole subtree (e.g. the `worker` deploy dir) when absent at dst;
      // dest wins if present (do not deep-merge node_modules). cpSync is EXDEV-safe.
      if (!fs.existsSync(df)) { fs.cpSync(sf, df, { recursive: true }); filled = true; }
      continue;
    }
    if (!entry.isFile()) continue; // skip sockets/fifos/symlinks (none expected in a team dir)
    if (!fs.existsSync(df)) { fs.copyFileSync(sf, df); filled = true; }
    else if (!filesEqual(sf, df)) { fs.copyFileSync(sf, df + BAK_SUFFIX); conflicted = true; }
  }
  const secretDisposition = reconcileSecretFile(src, dst, SECRETS_FILE + BAK_SUFFIX);
  if (secretDisposition === 'conflicted') conflicted = true;
  if (secretDisposition === 'copied') filled = true;
  return conflicted ? 'conflicted' : !existed ? 'copied' : filled ? 'gapFilled' : 'noop';
}

/** Every legacy file present at dst byte-identical (or archived); every legacy subdir present. */
function verifyCopied(src: string, dst: string): boolean {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sf = path.join(src, entry.name), df = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      // cpSync throws on a failed copy, so dst presence after reconcile means the subtree
      // landed; existence is sufficient (avoid a deep byte-walk of node_modules).
      if (!fs.existsSync(df)) return false;
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === SECRETS_FILE) {
      if (!fs.existsSync(df) || !ownerOnly(df)) return false;
      if (secretFilesEqual(sf, df)) continue;
      const backup = df + BAK_SUFFIX;
      if (!fs.existsSync(backup) || !ownerOnly(backup) || !secretFilesEqual(sf, backup)) return false;
      continue;
    }
    if (!fs.existsSync(df)) return false;
    if (!filesEqual(sf, df) && !fs.existsSync(df + BAK_SUFFIX)) return false;
  }
  return true;
}

export function migrateTeamsHomeIfNeeded(legacyHomes: string[] = defaultLegacyTeamHomes()): MigrateTeamsResult {
  const result: MigrateTeamsResult = { copied: [], gapFilled: [], conflicted: [], retiredHomes: [] };
  const destTeamsDir = resolveTeamsDir();
  const seen = new Set<string>();

  for (const home of legacyHomes) {
    const legacyTeamsDir = path.join(home, TEAMS_DIRNAME);
    if (pathsEquivalent(legacyTeamsDir, destTeamsDir)) continue; // dest is not a legacy source
    const key = path.resolve(legacyTeamsDir);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!fs.existsSync(legacyTeamsDir)) continue;

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(legacyTeamsDir, { withFileTypes: true }); } catch { continue; }
    preflightTeamSecrets(entries, legacyTeamsDir, destTeamsDir);

    let allVerified = true;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const src = path.join(legacyTeamsDir, entry.name);
      const dst = path.join(destTeamsDir, entry.name);
      let disposition: Disposition;
      try { disposition = reconcileTeamDir(src, dst); }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EEXIST') { allVerified = false; continue; } // racing process
        throw err;
      }
      if (!verifyCopied(src, dst)) { allVerified = false; continue; }
      if (disposition === 'copied') result.copied.push(entry.name);
      else if (disposition === 'gapFilled') result.gapFilled.push(entry.name);
      else if (disposition === 'conflicted') result.conflicted.push(entry.name);
    }

    if (!allVerified) continue; // leave the source intact for a later run
    withReconciledSecretFiles(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          sourceVaultDir: path.join(legacyTeamsDir, entry.name),
          destinationVaultDir: path.join(destTeamsDir, entry.name),
          backupFileName: SECRETS_FILE + BAK_SUFFIX,
        })),
      () => {
        if (!entries
          .filter((entry) => entry.isDirectory())
          .every((entry) => verifyCopied(path.join(legacyTeamsDir, entry.name), path.join(destTeamsDir, entry.name)))) {
          return;
        }
        const bak = legacyTeamsDir + BAK_SUFFIX;
        try {
          if (fs.existsSync(bak)) fs.rmSync(legacyTeamsDir, { recursive: true, force: true }); // already retired before
          else fs.renameSync(legacyTeamsDir, bak); // same-home rename: same filesystem, no EXDEV
          result.retiredHomes.push(legacyTeamsDir);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // ENOENT = another process retired it
        }
      },
    );
  }

  return result;
}
