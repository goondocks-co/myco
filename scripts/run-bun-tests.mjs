#!/usr/bin/env node
// Drives `bun test` in two passes: non-tsx tests (pure Node environment) and
// tsx tests (jsdom via a dedicated bunfig). Honors MYCO_TEST_PROFILE=fast |
// integration to match the former vitest-side configuration.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FAST_EXCLUDES = [
  'tests/integration/',
  'tests/smoke/',
  'tests/daemon/integration.test.ts',
  'tests/daemon/server.test.ts',
  'tests/hooks/client.test.ts',
];
const INTEGRATION_INCLUDES = [
  'tests/integration/',
  'tests/smoke/',
  'tests/daemon/integration.test.ts',
  'tests/daemon/server.test.ts',
  'tests/hooks/client.test.ts',
];

const profile = process.env.MYCO_TEST_PROFILE ?? '';

/**
 * Returns two arrays: [nonDomArgs, domArgs]. Each is an argv suffix passed to
 * `bun test`. `nonDomArgs` always ignores tsx files; `domArgs` always ignores
 * non-tsx files.
 */
function buildArgs() {
  if (profile === 'integration') {
    return {
      // Integration profile: tests/integration + tests/smoke plus a few
      // named files. None are tsx at time of writing.
      nonDom: [...INTEGRATION_INCLUDES, "--path-ignore-patterns=**/*.test.tsx"],
      dom: null,
    };
  }

  if (profile === 'fast') {
    // Fast profile: everything except the integration/smoke buckets.
    const ignores = [
      "--path-ignore-patterns=**/*.test.tsx",
      ...FAST_EXCLUDES.map((p) => `--path-ignore-patterns=${p}**`),
    ];
    return {
      nonDom: ['tests/', ...ignores],
      // Also run the UI tests in fast mode (they're quick).
      dom: ['tests/', '--path-ignore-patterns=!(**/*.test.tsx)'],
    };
  }

  return {
    nonDom: ['tests/', "--path-ignore-patterns=**/*.test.tsx"],
    dom: ['tests/'],
  };
}

function runPhase(label, extraArgs, bunfig) {
  if (extraArgs === null) return 0;
  // `BUN_CONFIG_FILE` is not observed by `bun test` for the bunfig; the only
  // reliable way to swap configs is to move the file on disk for the
  // duration of the run.
  const canonical = path.join(REPO, 'bunfig.toml');
  const backup = path.join(REPO, '.bunfig.toml.runner-backup');
  let restored = false;
  if (bunfig && bunfig !== canonical) {
    if (fs.existsSync(canonical)) fs.renameSync(canonical, backup);
    fs.copyFileSync(bunfig, canonical);
    restored = true;
  }
  try {
    console.log(`\n=== bun test (${label}) ===`);
    const args = ['test', '--isolate', ...extraArgs];
    const result = spawnSync('bun', args, {
      cwd: REPO,
      stdio: 'inherit',
      env: process.env,
    });
    return result.status ?? 1;
  } finally {
    if (restored) {
      fs.rmSync(canonical, { force: true });
      if (fs.existsSync(backup)) fs.renameSync(backup, canonical);
    }
  }
}

/**
 * npm installs a second copy of react + react-dom under
 * packages/myco/ui/node_modules whenever the ui workspace's peer versions
 * differ in any way from the root. When a tsx test then imports a component
 * via `packages/myco/ui/src/...`, that component resolves to the UI-local
 * React while `@testing-library/react` (from root) resolves to root's React.
 * Two React instances == broken hooks. Strip the duplicates before the tsx
 * pass; Bun.plugin `onResolve` hooks don't fire in time to re-route static
 * imports.
 */
function stripDuplicateReact() {
  const candidates = [
    path.join(REPO, 'packages/myco/ui/node_modules'),
    path.join(REPO, 'packages/myco-collective/ui/node_modules'),
    path.join(REPO, 'packages/myco-team/ui/node_modules'),
  ];
  for (const base of candidates) {
    for (const pkg of [
      'react',
      'react-dom',
      'react-router-dom',
      'react-router',
      '@tanstack/react-query',
      '@tanstack/query-core',
    ]) {
      const dupe = path.join(base, pkg);
      if (fs.existsSync(dupe)) {
        fs.rmSync(dupe, { recursive: true, force: true });
        console.log(`[run-bun-tests] removed duplicate ${pkg} at ${dupe}`);
      }
    }
  }
}

const { nonDom, dom } = buildArgs();
const nonDomStatus = runPhase('node env', nonDom, path.join(REPO, 'bunfig.toml'));

// Only run DOM phase if it's scoped to tsx (or the fast profile asked for it).
const domArgs = dom === null
  ? null
  : (profile === ''
    ? ['tests/', '--path-ignore-patterns=!(**/*.test.tsx)']
    : dom);

// bun test treats negation globs oddly. Simpler: find .tsx files directly.
function findTsxTests(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTsxTests(full, out);
    else if (entry.isFile() && entry.name.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

const tsxFiles = findTsxTests(path.join(REPO, 'tests'));
let domStatus = 0;
if (tsxFiles.length > 0) {
  stripDuplicateReact();
  domStatus = runPhase(
    'jsdom',
    tsxFiles.map((f) => path.relative(REPO, f)),
    path.join(REPO, 'bunfig.dom.toml'),
  );
}

process.exit(nonDomStatus || domStatus);
