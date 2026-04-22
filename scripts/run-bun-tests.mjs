#!/usr/bin/env node
// Drives `bun test` in two passes: non-tsx tests (pure Node environment) and
// tsx tests (jsdom via a dedicated bunfig). Honors MYCO_TEST_PROFILE=fast |
// integration to match the former vitest-side configuration.

import { spawnSync } from 'node:child_process';
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
  const env = { ...process.env };
  if (bunfig) env.BUN_CONFIG_FILE = bunfig;
  console.log(`\n=== bun test (${label}) ===`);
  const args = ['test', '--isolate', ...extraArgs];
  const result = spawnSync('bun', args, {
    cwd: REPO,
    stdio: 'inherit',
    env,
  });
  return result.status ?? 1;
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
import fs from 'node:fs';
function findTsxTests(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTsxTests(full, out);
    else if (entry.isFile() && entry.name.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

const tsxFiles = findTsxTests(path.join(REPO, 'tests'));
const domStatus = tsxFiles.length === 0
  ? 0
  : runPhase('jsdom', tsxFiles.map((f) => path.relative(REPO, f)), path.join(REPO, 'bunfig.dom.toml'));

process.exit(nonDomStatus || domStatus);
