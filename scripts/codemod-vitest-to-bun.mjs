#!/usr/bin/env node
// One-off codemod: rewrite `from 'vitest'` imports in tests/ to split between
// `bun:test` (lifecycle helpers) and the local vi-shim (for `vi`). Delete
// after the vitest -> bun test migration lands.
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const TESTS_DIR = path.join(REPO, 'tests');
const SHIM_ABS = path.join(TESTS_DIR, 'helpers', 'vi-shim.ts');

const BUN_LIFECYCLE = new Set([
  'describe',
  'it',
  'test',
  'expect',
  'beforeAll',
  'beforeEach',
  'afterAll',
  'afterEach',
]);

/** Recursively collect .ts/.tsx files under tests/. */
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function shimImportPath(fromFile) {
  const rel = path.relative(path.dirname(fromFile), SHIM_ABS);
  // Drop .ts and use .js for ESM resolution.
  const withoutExt = rel.replace(/\.ts$/, '');
  const normalized = withoutExt.startsWith('.') ? withoutExt : `./${withoutExt}`;
  return `${normalized}.js`;
}

function rewriteVitestImport(source, fromFile) {
  // Match a single-line import from 'vitest' (covers every form currently in
  // the tree per `grep`'s inventory).
  const RE = /^import\s*\{([^}]+)\}\s*from\s*['"]vitest['"]\s*;?\s*$/m;
  const match = source.match(RE);
  if (!match) return source;

  const names = match[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bunNames = names.filter((n) => BUN_LIFECYCLE.has(n));
  const viNames = names.filter((n) => !BUN_LIFECYCLE.has(n));

  const lines = [];
  if (bunNames.length > 0) {
    lines.push(`import { ${bunNames.join(', ')} } from 'bun:test';`);
  }
  if (viNames.length > 0) {
    // All non-lifecycle names should be `vi`. Route through the shim.
    lines.push(`import { ${viNames.join(', ')} } from '${shimImportPath(fromFile)}';`);
  }

  return source.replace(RE, lines.join('\n'));
}

function rewriteJestDomImport(source) {
  return source.replace(
    /@testing-library\/jest-dom\/vitest/g,
    '@testing-library/jest-dom',
  );
}

let touched = 0;
for (const file of walk(TESTS_DIR)) {
  const before = fs.readFileSync(file, 'utf8');
  let after = rewriteVitestImport(before, file);
  after = rewriteJestDomImport(after);
  if (after !== before) {
    fs.writeFileSync(file, after);
    touched += 1;
  }
}
console.log(`codemod: rewrote ${touched} files`);
