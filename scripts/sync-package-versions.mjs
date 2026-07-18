#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();
const LEGACY_MYCO_TAG_PATTERN = 'v*.*.*';

// Files in the myco target whose `optionalDependencies` for the
// `@goondocks/myco-<platform>` packages must be re-pinned to the release
// version on every bump. Without this, a tagged @goondocks/myco@X.Y.Z would
// ask npm to install platform packages at a stale version that doesn't
// exist on the registry.
const MYCO_PLATFORM_OPTIONAL_DEPS = [
  '@goondocks/myco-darwin-arm64',
  '@goondocks/myco-darwin-x64',
  '@goondocks/myco-linux-x64',
  '@goondocks/myco-linux-arm64',
  '@goondocks/myco-windows-x64',
];

const PACKAGE_TARGETS = [
  {
    envKey: 'MYCO_VERSION',
    tagPrefix: 'myco',
    legacyTagPattern: LEGACY_MYCO_TAG_PATTERN,
    files: [
      'package.json',
      'packages/myco/package.json',
      'packages/myco/ui/package.json',
      'packages/myco-darwin-arm64/package.json',
      'packages/myco-darwin-x64/package.json',
      'packages/myco-linux-x64/package.json',
      'packages/myco-linux-arm64/package.json',
      'packages/myco-windows-x64/package.json',
    ],
    rewriteOptionalDeps: {
      'packages/myco/package.json': MYCO_PLATFORM_OPTIONAL_DEPS,
    },
  },
  {
    envKey: 'MYCO_SHARED_VERSION',
    tagPrefix: 'myco-shared',
    files: [
      'packages/myco-shared/package.json',
    ],
  },
];

function usage() {
  return [
    'Usage:',
    '  node scripts/sync-package-versions.mjs',
    '  node scripts/sync-package-versions.mjs --target <tag-prefix> --version <version>',
    '',
    'Without arguments, syncs every known package from explicit env vars or latest git tags.',
    'With --target/--version, syncs only the package family for the release tag.',
  ].join('\n');
}

function readArg(name) {
  const exact = process.argv.indexOf(name);
  if (exact !== -1) return process.argv[exact + 1] ?? '';

  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : '';
}

function releaseTargetFromArgs() {
  const tagPrefix = readArg('--target').trim();
  const version = readArg('--version').trim();

  if (!tagPrefix && !version) return null;
  if (!tagPrefix || !version) {
    throw new Error(`--target and --version must be provided together\n\n${usage()}`);
  }

  const target = PACKAGE_TARGETS.find((candidate) => candidate.tagPrefix === tagPrefix);
  if (!target) {
    throw new Error(`Unknown target: ${tagPrefix}\n\n${usage()}`);
  }

  return { target, version };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function listTags(pattern) {
  // `--sort=-version:refname` without a prerelease-suffix config sorts
  // `v0.22.0-beta.5` ABOVE `v0.22.0`, which is the opposite of semver: a
  // release is higher than any of its prereleases. `versionsort.suffix` tells
  // git that `-beta` (and any other listed suffix) marks a prerelease, so a
  // bare version sorts above anything carrying the suffix. We list each known
  // prerelease marker separately via repeated `-c`.
  const output = execFileSync(
    'git',
    [
      '-c', 'versionsort.suffix=-alpha',
      '-c', 'versionsort.suffix=-beta',
      '-c', 'versionsort.suffix=-rc',
      '-c', 'versionsort.suffix=-pre',
      'tag', '--list', pattern, '--sort=-version:refname',
    ],
    { cwd: repoRoot, encoding: 'utf-8' },
  ).trim();
  return output ? output.split('\n').filter(Boolean) : [];
}

function versionFromTag(tag, prefix) {
  return prefix ? tag.replace(`${prefix}/v`, '') : tag.replace(/^v/, '');
}

function resolveVersion(target) {
  const explicit = process.env[target.envKey]?.trim();
  if (explicit) return explicit;

  const prefixedTag = listTags(`${target.tagPrefix}/v*`).at(0);
  if (prefixedTag) return versionFromTag(prefixedTag, target.tagPrefix);

  if (target.legacyTagPattern) {
    const legacyTag = listTags(target.legacyTagPattern).at(0);
    if (legacyTag) return versionFromTag(legacyTag, null);
  }

  return null;
}

function syncTargetVersions() {
  const releaseTarget = releaseTargetFromArgs();
  const targets = releaseTarget ? [releaseTarget.target] : PACKAGE_TARGETS;
  const applied = [];

  for (const target of targets) {
    const nextVersion = releaseTarget ? releaseTarget.version : resolveVersion(target);
    if (!nextVersion) continue;

    for (const relativePath of target.files) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) continue;

      const current = readJson(absolutePath);
      const depsToRewrite = target.rewriteOptionalDeps?.[relativePath] ?? [];
      const needsVersionBump = current.version !== nextVersion;
      const needsDepRewrite = depsToRewrite.some(
        (depName) => current.optionalDependencies?.[depName] !== nextVersion,
      );

      if (!needsVersionBump && !needsDepRewrite) continue;

      current.version = nextVersion;
      if (depsToRewrite.length > 0) {
        current.optionalDependencies = current.optionalDependencies ?? {};
        for (const depName of depsToRewrite) {
          current.optionalDependencies[depName] = nextVersion;
        }
      }
      writeJson(absolutePath, current);
      applied.push({
        file: relativePath,
        version: nextVersion,
        rewroteDeps: depsToRewrite.length > 0,
      });
    }
  }

  for (const update of applied) {
    const note = update.rewroteDeps ? ' (+ optionalDependencies)' : '';
    console.log(`${update.file}: ${update.version}${note}`);
  }
}

syncTargetVersions();
