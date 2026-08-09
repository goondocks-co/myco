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
/**
 * Shipping user-facing text describes the transport the code HAS.
 *
 * The 1.4.0 transport change (a Myco-provisioned headscale/WireGuard overlay →
 * a Tailscale-Funnel-fronted public HTTPS endpoint) was invisible to every
 * check: the README, the landing page, `docs/team-host.md`, and the installer
 * kept advertising `--server-url`/`--overlay-address` and "encrypted overlay"
 * long after the flags stopped being read and the overlay stopped existing.
 * `help-matches-parser` guarded the CLI help strings; nothing guarded the docs,
 * the installer, or the dashboard copy. This is that guard.
 *
 * It is a DETERMINISTIC vocabulary/flag check, not a spell-checker: it fails on
 * the exact retired tokens, so a doc that reintroduces one goes red in the same
 * diff. CHANGELOG.md is excluded on purpose — it NARRATES the removal ("replaced
 * the overlay transport"), which is the one place those words belong.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOST_HELP } from '@myco/cli/host';
import { JOIN_HELP, LEAVE_HELP } from '@myco/cli/join';

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

/** Long flags a text tells the user to pass. */
function longFlags(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(/--([a-z][a-z0-9-]+)/g), (m) => m[1]!))];
}

/**
 * Long flags advertised specifically on team-host command lines — a `myco
 * host/join/leave/attach/detach` invocation, or the `--serve` installer path.
 * Scoping to those lines keeps flags for unrelated commands (`doctor --fix`,
 * `uninstall --purge`) and third-party tools in the installer (jq's `--arg`)
 * out of the check, which is only about the team-host surface.
 */
function teamHostFlags(text: string): string[] {
  const context = /\bmyco (host|join|leave|attach|detach)\b|--serve\b/;
  const flags = new Set<string>();
  for (const line of text.split('\n')) {
    if (!context.test(line)) continue;
    for (const flag of longFlags(line)) flags.add(flag);
  }
  return [...flags];
}

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

  test('every flag the README + installer advertise is a real, parsed flag', () => {
    // The real flag vocabulary IS the CLI help (which `help-matches-parser`
    // already pins to the parsers), plus the attach/detach/installer flags no
    // team-host help string carries.
    const realFlags = new Set<string>([
      ...longFlags(HOST_HELP),
      ...longFlags(JOIN_HELP),
      ...longFlags(LEAVE_HELP),
      // attach/detach + installer + generic — documented outside host/join help.
      'host', 'project-id', 'allow-no-pull', 'serve', 'hostname', 'help',
    ]);

    const surfaces = ['README.md', 'docs/install.sh', 'docs/team-host.md'];
    const phantom: string[] = [];
    for (const rel of surfaces) {
      for (const flag of teamHostFlags(read(rel))) {
        if (!realFlags.has(flag)) phantom.push(`${rel}: --${flag}`);
      }
    }
    expect(
      phantom,
      'These surfaces advertise a flag no parser reads — a user copying the command gets silence, '
      + 'not an error. Document only real flags (see HOST_HELP / JOIN_HELP).\n\n' + phantom.join('\n'),
    ).toEqual([]);
  });

  test('no dashboard copy names the retired transport', () => {
    // The comment gate (`comments-describe-current-state`) covers ui/ COMMENTS;
    // this covers ui/ COPY. Matched as multi-word phrases + retired product
    // names, so a modal `DialogOverlay`, a CSS `overlay-opacity`, or the
    // `overlaySupported` capability flag never trip it — only prose that names
    // the dead networking does.
    const uiPhrases: Array<{ label: string; re: RegExp }> = [
      { label: '--server-url', re: /--server-url/i },
      { label: '--overlay-address', re: /--overlay-address/i },
      { label: 'headscale', re: /headscale/i },
      { label: 'wireguard', re: /wireguard/i },
      { label: 'overlay client', re: /overlay client/i },
      { label: 'overlay connection', re: /overlay connection/i },
      { label: 'overlay network', re: /overlay network/i },
      { label: 'encrypted overlay', re: /encrypted overlay/i },
      { label: 'control plane', re: /control plane/i },
    ];
    const hits: string[] = [];
    for (const abs of filesUnder(path.join(REPO_ROOT, 'packages', 'myco', 'ui', 'src'), ['.ts', '.tsx'])) {
      if (abs.endsWith('.test.ts') || abs.endsWith('.test.tsx')) continue;
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      read(rel).split('\n').forEach((line, i) => {
        for (const { label, re } of uiPhrases) {
          if (re.test(line)) hits.push(`${rel}:${i + 1}  [${label}]  ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(
      hits,
      'Dashboard source still names the retired overlay transport. Rewrite the copy to the '
      + 'Funnel-address model.\n\n' + hits.join('\n'),
    ).toEqual([]);
  });
});
