import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tightenSecretsPermissions } from '../config/secrets.js';
import { pathsEquivalent, resolveTeamsDir, TEAMS_DIRNAME } from '../grove/paths.js';

const BAK_SUFFIX = '.bak-pre-myco-team';

export interface MigrateTeamsResult {
  copied: string[]; gapFilled: string[]; conflicted: string[]; retiredHomes: string[];
}

type Disposition = 'copied' | 'gapFilled' | 'conflicted' | 'noop';

/**
 * Legacy machine homes to sweep, passed explicitly (NOT recomputed from $HOME:
 * Bun's os.homedir() ignores $HOME set after launch). Defaults to the known
 * sibling homes plus the current MYCO_HOME if set.
 */
export function defaultLegacyTeamHomes(homeDir: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const homes = [path.join(homeDir, '.myco'), path.join(homeDir, '.myco-dev')];
  const current = env.MYCO_HOME?.trim();
  if (current) homes.push(path.resolve(current));
  return homes;
}

function filesEqual(a: string, b: string): boolean {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

/** Fill missing files into dst; archive (never overwrite) a divergent file. Dest wins. */
function reconcileTeamDir(src: string, dst: string): Disposition {
  const existed = fs.existsSync(dst);
  fs.mkdirSync(dst, { recursive: true });
  let filled = false, conflicted = false;
  for (const file of fs.readdirSync(src)) {
    const sf = path.join(src, file), df = path.join(dst, file);
    if (!fs.statSync(sf).isFile()) continue; // team dirs are flat
    if (!fs.existsSync(df)) { fs.copyFileSync(sf, df); filled = true; }
    else if (!filesEqual(sf, df)) { fs.copyFileSync(sf, df + BAK_SUFFIX); conflicted = true; }
  }
  tightenSecretsPermissions(dst); // force 0o600 on copied secrets.env
  return conflicted ? 'conflicted' : !existed ? 'copied' : filled ? 'gapFilled' : 'noop';
}

/** Every legacy file present at dst byte-identical, or archived. */
function verifyCopied(src: string, dst: string): boolean {
  for (const file of fs.readdirSync(src)) {
    const sf = path.join(src, file), df = path.join(dst, file);
    if (!fs.statSync(sf).isFile()) continue;
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
    const bak = legacyTeamsDir + BAK_SUFFIX;
    try {
      if (fs.existsSync(bak)) fs.rmSync(legacyTeamsDir, { recursive: true, force: true }); // already retired before
      else fs.renameSync(legacyTeamsDir, bak); // same-home rename: same filesystem, no EXDEV
      result.retiredHomes.push(legacyTeamsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // ENOENT = another process retired it
    }
  }

  return result;
}
