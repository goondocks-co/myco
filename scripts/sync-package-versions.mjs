#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();
const LEGACY_MYCO_TAG_PATTERN = 'v*.*.*';

const PACKAGE_TARGETS = [
  {
    envKey: 'MYCO_VERSION',
    tagPrefix: 'myco',
    legacyTagPattern: LEGACY_MYCO_TAG_PATTERN,
    files: [
      'package.json',
      'packages/myco/package.json',
      'packages/myco/ui/package.json',
    ],
  },
  {
    envKey: 'MYCO_TEAM_VERSION',
    tagPrefix: 'myco-team',
    files: [
      'packages/myco-team/package.json',
      'packages/myco-team/worker/package.json',
    ],
  },
  {
    envKey: 'MYCO_COLLECTIVE_VERSION',
    tagPrefix: 'myco-collective',
    files: [
      'packages/myco-collective/package.json',
      'packages/myco-collective/ui/package.json',
      'packages/myco-collective/worker/package.json',
    ],
  },
];

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
  const applied = [];

  for (const target of PACKAGE_TARGETS) {
    const nextVersion = resolveVersion(target);
    if (!nextVersion) continue;

    for (const relativePath of target.files) {
      const absolutePath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolutePath)) continue;

      const current = readJson(absolutePath);
      if (current.version === nextVersion) continue;

      current.version = nextVersion;
      writeJson(absolutePath, current);
      applied.push({ file: relativePath, version: nextVersion });
    }
  }

  for (const update of applied) {
    console.log(`${update.file}: ${update.version}`);
  }
}

syncTargetVersions();
