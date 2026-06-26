// Shared helpers for the source-tree → TypeScript bundle codegen scripts
// (gen-templates.mjs, gen-skills.mjs). Both embed a directory tree into a
// generated .ts file as JSON string literals; only the per-entry serialization
// differs (flat `Record<relPath, content>` vs nested
// `Record<skillName, Record<relPath, content>>`). Everything else — tree walk,
// text-only guards, and the write-vs-`--check` harness — lives here so the two
// generators cannot drift.
//
// Plain ESM, no dependencies: these run via `node` straight from the checkout.

import fs from 'node:fs';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';

/**
 * Recursively list every real file under `dir` (absolute paths).
 *
 * The bundles embed each file's bytes as a JSON string literal, so the tree
 * must contain only real, text files. A symlink (to a file OR a directory)
 * THROWS rather than being silently skipped: the previous walk dropped symlinks
 * with no trace, which would quietly omit a file from the bundle. Fail loud
 * instead. UTF-8 validation happens at read time in `readTextFile`, so each file
 * is read exactly once.
 */
export function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `[codegen-bundle] refusing to bundle symlink: ${full} — bundles must contain only real, text files.`,
      );
    }
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
}

/**
 * Read a file as UTF-8, throwing if its bytes are not valid UTF-8.
 *
 * Contents are serialized as JSON string literals; a binary asset read as
 * 'utf-8' would be silently corrupted by replacement characters. Fail the build
 * so a future binary asset is caught at codegen time — switch to base64
 * encode-here / decode-in-consumer if one is ever genuinely required.
 */
export function readTextFile(abs) {
  const buf = fs.readFileSync(abs);
  if (!isUtf8(buf)) {
    throw new Error(
      `[codegen-bundle] ${abs} is not valid UTF-8 — these bundles are text-only.`,
    );
  }
  return buf.toString('utf-8');
}

/**
 * Sorted names of every immediate subdirectory of `skillsRoot` that contains a
 * SKILL.md — the same "a dir is a skill iff it has SKILL.md" predicate the
 * installer uses. A missing root yields an empty list.
 */
export function listSkillDirs(skillsRoot) {
  let entries;
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(skillsRoot, name, 'SKILL.md')))
    .sort();
}

/**
 * Shared write-vs-`--check` harness.
 *
 * The compiled binary reads ONLY the generated .ts file, so a forgotten codegen
 * silently ships a stale bundle. In `--check` mode (CI / test guard) this
 * byte-compares the committed file against the freshly-built `content` and exits
 * 1 on drift; otherwise it writes the file. `count` is a pre-formatted summary
 * string (e.g. "26 files") so each generator keeps its own message wording.
 */
export function emitBundle({ outputPath, pkgRoot, content, count, label, checkMode }) {
  const rel = path.relative(pkgRoot, outputPath);
  if (checkMode) {
    let committed = null;
    try {
      committed = fs.readFileSync(outputPath, 'utf-8');
    } catch {
      committed = null;
    }
    if (committed !== content) {
      process.stderr.write(
        `[${label}] ${rel} is stale — run \`npm run codegen\` and commit the result.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`[${label}] ${rel} is in sync (${count})\n`);
    process.exit(0);
  }
  fs.writeFileSync(outputPath, content, 'utf-8');
  process.stdout.write(`[${label}] wrote ${rel} (${count})\n`);
}
