/*
 * Copyright 2026 Myco Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/** Shipping docs, installers and dashboard copy use the supported transport vocabulary. */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

/** Every file under `dir` whose name ends with one of `exts`, recursively. */
function filesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...filesUnder(full, exts)); continue; }
    if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * Git-TRACKED files under `dir` (repo-relative, forward-slash) matching
 * `exts`. "Shipping" is defined by version control: only a tracked file can
 * ship, so gitignored local material under the same tree (e.g. the
 * developer's `docs/superpowers/` plans, which legitimately discuss retired
 * vocabulary) must never trip a shipping-surface check. A dev checkout has
 * those files on disk while CI does not — a plain filesystem walk makes this
 * suite pass in CI and fail locally on the same commit. Falls back to the
 * filesystem walk when git is unavailable (e.g. an exported tarball).
 */
function trackedFilesUnder(dir: string, exts: string[]): string[] {
  const relDir = path.relative(REPO_ROOT, dir).split(path.sep).join('/');
  try {
    return execFileSync('git', ['ls-files', '-z', '--', relDir], { cwd: REPO_ROOT })
      .toString('utf-8')
      .split('\0')
      .filter((f) => f.length > 0 && exts.some((e) => f.endsWith(e)));
  } catch {
    return filesUnder(dir, exts).map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'));
  }
}

/**
 * Retired transport vocabulary. Each entry is a phrase or literal that only
 * ever meant the removed model — so a plain substring/word match cannot false-
 * positive on live copy. `overlay` is matched only as a STANDALONE word (never
 * inside a CSS identifier like `hero-image-overlay` or `overlay-opacity`), so
 * the landing page's markup is untouched.
 */
const RETIRED_VOCAB: Array<{ label: string; re: RegExp }> = [
  { label: '--server-url', re: /--server-url/i },
  { label: '--overlay-address', re: /--overlay-address/i },
  { label: 'headscale', re: /headscale/i },
  { label: 'wireguard', re: /wireguard/i },
  { label: 'control plane', re: /control plane/i },
  { label: 'peer-to-peer', re: /peer[- ]to[- ]peer/i },
  { label: 'tailnet to join', re: /tailnet to join/i },
  { label: 'overlay (as a standalone word)', re: /(?<![-\w])overlay(?![-\w])/i },
];

describe('user-facing surface matches the shipped transport', () => {
  // README + everything under docs/ EXCEPT CHANGELOG (which lives at the repo
  // root and legitimately narrates the removal). install.sh and index.html are
  // shipped verbatim from docs/, so they are in scope too.
  const docFiles = [
    'README.md',
    ...trackedFilesUnder(path.join(REPO_ROOT, 'docs'), ['.md', '.html', '.sh']),
  ];

  test('no shipping doc names the retired overlay transport or its dead flags', () => {
    const hits: string[] = [];
    for (const rel of docFiles) {
      const lines = read(rel).split('\n');
      lines.forEach((line, i) => {
        for (const { label, re } of RETIRED_VOCAB) {
          if (re.test(line)) hits.push(`${rel}:${i + 1}  [${label}]  ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(
      hits,
      'These shipping docs still describe the retired headscale/WireGuard overlay or its dead flags. '
      + 'The transport is a Tailscale Funnel address + per-member token; rewrite to that model. '
      + '(CHANGELOG.md is exempt — it narrates the removal.)\n\n' + hits.join('\n'),
    ).toEqual([]);
  });

});
