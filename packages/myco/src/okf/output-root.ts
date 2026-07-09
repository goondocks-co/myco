import fs from 'node:fs';
import path from 'node:path';
import { OkfError } from './errors.js';
import type { OkfBundleMode } from './types.js';

/**
 * Output-root policy — the single decision point for WHERE a bundle may be
 * written and what class of write it is. Pure except for symlink/existence
 * probes; every rejection is `OkfError('invalid_okf_output_root')`.
 *
 * Three classes:
 * - `published_default` — the repo-visible bundle at `<projectRoot>/<publishedPath>`
 *   (default `okf`). The only class a scheduled run may publish.
 * - `private_local` — the gitignored local-mode bundle at `.myco/okf/bundle`.
 * - `external_export` — anywhere else; requires `allowExternalOutput` and is
 *   never scheduled.
 */

export type OutputClass = 'published_default' | 'private_local' | 'external_export';

export interface ResolveOutputRootInput {
  projectRoot: string;
  mode: OkfBundleMode;
  /** Explicit output root from the write input (absolute, or relative to projectRoot). */
  requested?: string;
  /** Configured published path relative to projectRoot (default 'okf'). */
  publishedPath?: string;
  /** Absolute local-mode bundle dir (vault.okfLocalBundleDir()); required for mode 'local'. */
  localBundleDir?: string;
  allowExternalOutput?: boolean;
}

export interface ResolvedOutputRoot {
  absPath: string;
  klass: OutputClass;
}

/** Canonicalize a path that may not exist yet by realpath-ing its nearest existing ancestor. */
function canonicalizeAllowingMissing(target: string): string {
  let existing = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(existing);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) {
        // Reached the filesystem root without an existing ancestor — return the
        // lexically-normalized absolute path.
        return path.normalize(target);
      }
      tail.push(path.basename(existing));
      existing = parent;
    }
  }
}

function reject(message: string, details?: unknown): never {
  throw new OkfError('invalid_okf_output_root', message, details);
}

/** True when `child` is `ancestor` or lives beneath it. */
function isAtOrUnder(child: string, ancestor: string): boolean {
  if (child === ancestor) return true;
  const rel = path.relative(ancestor, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function resolveOutputRoot(input: ResolveOutputRootInput): ResolvedOutputRoot {
  const publishedPath = input.publishedPath ?? 'okf';
  if (input.requested?.includes('\0') || publishedPath.includes('\0')) {
    reject('output root contains a NUL byte');
  }

  const projectRoot = canonicalizeAllowingMissing(path.resolve(input.projectRoot));
  const publishedDefault = canonicalizeAllowingMissing(path.resolve(projectRoot, publishedPath));
  const localBundle = input.localBundleDir
    ? canonicalizeAllowingMissing(path.resolve(input.localBundleDir))
    : null;

  // Determine the candidate absolute path from mode + requested.
  let candidate: string;
  if (input.mode === 'local') {
    if (!localBundle) reject('local mode requires a localBundleDir');
    if (input.requested && canonicalizeAllowingMissing(path.resolve(projectRoot, input.requested)) !== localBundle) {
      reject('local mode output root must be the vault local bundle dir');
    }
    candidate = localBundle;
  } else {
    candidate = input.requested
      ? canonicalizeAllowingMissing(path.resolve(projectRoot, input.requested))
      : publishedDefault;
  }

  // Forbidden locations (checked against the canonicalized real path so a
  // symlinked root cannot smuggle a write into .git, .myco control state, etc).
  const vaultDir = path.join(projectRoot, '.myco');
  const okfHome = path.join(vaultDir, 'okf');
  const forbidden: Array<{ p: string; why: string }> = [
    { p: projectRoot, why: 'the project root itself' },
    { p: path.join(projectRoot, '.git'), why: 'the .git directory' },
    { p: vaultDir, why: 'the .myco vault dir' },
    { p: okfHome, why: 'the .myco/okf control-state home' },
    { p: path.join(okfHome, 'state'), why: 'the OKF control-state dir' },
    { p: path.join(okfHome, 'staging'), why: 'the OKF staging dir' },
  ];
  for (const { p, why } of forbidden) {
    if (candidate === p) reject(`output root may not be ${why}`);
  }
  // Any parent of projectRoot (candidate is a strict ancestor of projectRoot).
  if (candidate !== projectRoot && isAtOrUnder(projectRoot, candidate)) {
    reject('output root may not be a parent of the project root');
  }
  // node_modules or .git anywhere in the path segments beneath projectRoot.
  if (isAtOrUnder(candidate, projectRoot)) {
    const rel = path.relative(projectRoot, candidate);
    for (const seg of rel.split(path.sep)) {
      if (seg === 'node_modules') reject('output root may not be inside node_modules');
      if (seg === '.git') reject('output root may not be inside the .git directory');
    }
  }

  // Classify.
  let klass: OutputClass;
  if (candidate === publishedDefault) {
    klass = 'published_default';
  } else if (localBundle && candidate === localBundle) {
    klass = 'private_local';
  } else {
    klass = 'external_export';
  }

  if (klass === 'external_export') {
    if (!input.allowExternalOutput) {
      reject('output root is outside the managed locations; pass allowExternalOutput to write it');
    }
  } else if (!isAtOrUnder(candidate, projectRoot)) {
    // Defense-in-depth: managed classes are always inside the project.
    reject('managed output root resolved outside the project root');
  }

  return { absPath: candidate, klass };
}
