/**
 * Seed the managed skills directory (`<mycoHome>/skills`) from the
 * binary-embedded skill bundle.
 *
 * Why this exists: global skill symlinks (`~/.claude/skills/<name>` etc.) must
 * resolve to a stable, managed location that survives any checkout/worktree
 * deletion. No install kind ships a `skills/` tree under `~/.myco` — the npm
 * versions dirs and curl downloads hold only the binary — so the managed daemon
 * binary (`resolvePackageRoot()` falls to `cwd=/` under launchd) had nothing to
 * source, leaving native/curl installs with zero global skills and no path to
 * self-heal. Embedding the skills in the binary (skills.generated.ts) and
 * writing them here makes the source uniform across npm + curl + dev.
 *
 * `<mycoHome>/skills` is wholly Myco-owned, so this mirrors the bundle exactly:
 * current files are written (content-gated to avoid churn) and anything not in
 * the bundle is pruned, so a renamed/removed skill leaves no stale source behind.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { managedSkillsDir } from '../install/managed-binary.js';
import { BUNDLED_SKILLS } from './skills.generated.js';

/**
 * Write the embedded skill bundle to `<mycoHome>/skills`, mirroring it exactly.
 * Idempotent and best-effort per file: a write failure for one file does not
 * abort the rest. Callers gate this on subsystem-claim ownership so a dev/
 * worktree build can't overwrite the managed skills with in-development content.
 *
 * Runs on every detection tick (hourly) by design — that's the self-heal path
 * for a deleted/corrupted source dir. Writes are content-gated (a steady-state
 * tick only re-reads the ~dozen bundle files and writes nothing), so the
 * recurring cost is negligible and buys continuous healing.
 */
export function ensureManagedSkills(mycoHome: string): void {
  const skillsDir = managedSkillsDir(mycoHome);
  const currentSkills = new Set(Object.keys(BUNDLED_SKILLS));

  // Prune anything not in the current bundle. `<mycoHome>/skills` is wholly
  // Myco-owned, so a stale entry must not linger — whether a renamed/removed
  // skill DIR or a stray file/symlink left by a prior version (rmSync with
  // recursive+force handles dir, file, and symlink alike).
  try {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!currentSkills.has(entry.name)) {
        fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
      }
    }
  } catch { /* skillsDir doesn't exist yet — nothing to prune */ }

  for (const [skillName, files] of Object.entries(BUNDLED_SKILLS)) {
    const skillDir = path.join(skillsDir, skillName);
    const wanted = new Set(Object.keys(files));

    // Prune files within a kept skill that the bundle no longer carries.
    pruneStaleFiles(skillDir, skillDir, wanted);

    for (const [relPath, content] of Object.entries(files)) {
      const dest = path.join(skillDir, relPath);
      try {
        if (fs.readFileSync(dest, 'utf-8') === content) continue;
      } catch { /* absent or unreadable — (re)write below */ }
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        atomicWriteFileSync(dest, content);
      } catch { /* best-effort — a missing skill file just means that skill won't link */ }
    }
  }
}

/** Remove files under `dir` whose path (relative to `skillRoot`) isn't in `wanted`. */
function pruneStaleFiles(dir: string, skillRoot: string, wanted: Set<string>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      pruneStaleFiles(full, skillRoot, wanted);
      try { fs.rmdirSync(full); } catch { /* not empty (still-wanted files) or already gone */ }
    } else {
      const rel = path.relative(skillRoot, full).split(path.sep).join('/');
      if (!wanted.has(rel)) {
        try { fs.rmSync(full, { force: true }); } catch { /* already gone */ }
      }
    }
  }
}
