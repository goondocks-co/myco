#!/usr/bin/env node
// The dashboard's component-only ratchet.
//
// Outside `ui/src/design/`, a page builds with the design system's components
// and tokens, not with raw controls, inline styles, colour literals or type
// under 12px. This script counts what still breaks that rule, per file and per
// kind, against the pinned baseline in
// `tests/meta/ui-component-only.baseline.json`. A count may only go down.
//
//   node scripts/ui-component-ratchet.mjs          report the current counts against the baseline
//   node scripts/ui-component-ratchet.mjs --write  pin the current counts, refusing any that grew
//
// `tests/meta/ui-component-only.test.ts` holds the same rule in CI.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const UI_SRC = path.join(REPO, 'packages', 'myco-server', 'ui', 'src');
export const BASELINE_PATH = path.join(REPO, 'tests', 'meta', 'ui-component-only.baseline.json');

/** The root font size the dashboard's rem-based classes resolve against. */
const ROOT_PX = 14;
const FLOOR_PX = 12;

const COLOUR_PREFIX = '(?:text|bg|border(?:-[trblxy])?|ring(?:-offset)?|fill|stroke|from|via|to|outline|divide|decoration|accent|caret|placeholder|shadow)';

/** Each kind of violation: its name, and how to count it in a source file. */
export const RULES = [
  { kind: 'raw-button', count: (src) => matches(src, /<button\b/g) },
  { kind: 'raw-input', count: (src) => matches(src, /<input\b/g) },
  { kind: 'raw-select', count: (src) => matches(src, /<select\b/g) },
  { kind: 'raw-textarea', count: (src) => matches(src, /<textarea\b/g) },
  { kind: 'raw-table', count: (src) => matches(src, /<table\b/g) },
  { kind: 'inline-style', count: (src) => matches(src, /style=\{\{/g) },
  {
    kind: 'colour-literal',
    count: (src) => matches(src, /(?<=[\s'"`(:,])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g)
      + matches(src, /\b(?:rgba?|hsla?)\(/g),
  },
  { kind: 'arbitrary-colour', count: (src) => matches(src, new RegExp(`\\b${COLOUR_PREFIX}-\\[[^\\]\\s]*(?:#[0-9a-fA-F]{3}|rgba?\\(|hsla?\\(|color-mix|var\\(--)`, 'g')) },
  { kind: 'small-text', count: smallText },
  { kind: 'retired-import', count: (src) => matches(src, /from\s+['"][^'"]*components\/ui\/[^'"]+['"]/g) },
];

function matches(src, re) {
  return (src.match(re) ?? []).length;
}

/** Type under 12px: `text-xs` (10.5px at the 14px root), arbitrary sizes, the mono eyebrow classes, and CSS font sizes. */
function smallText(src) {
  let n = matches(src, /\btext-xs\b/g) + matches(src, /\bmyco-eyebrow(?:-sm)?\b/g);
  for (const m of src.matchAll(/\btext-\[(\d+(?:\.\d+)?)(px|rem)\]/g)) {
    if (toPx(Number(m[1]), m[2]) < FLOOR_PX) n += 1;
  }
  for (const m of src.matchAll(/font-size:\s*(\d+(?:\.\d+)?)(px|rem)\b/g)) {
    if (toPx(Number(m[1]), m[2]) < FLOOR_PX) n += 1;
  }
  return n;
}

function toPx(value, unit) {
  return unit === 'rem' ? value * ROOT_PX : value;
}

/** The violations in one source text, by kind; kinds with none are left out. */
export function countSource(src) {
  const out = {};
  for (const rule of RULES) {
    const n = rule.count(src);
    if (n > 0) out[rule.kind] = n;
  }
  return out;
}

/** Every source file under `root` outside its `design/` folder, as paths relative to `root`. */
export function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (rel === 'design') continue;
        walk(full);
      } else if (/\.(tsx?|css)$/.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** The violations of every file under `root` that has any, by file then kind. */
export function countTree(root = UI_SRC) {
  const out = {};
  for (const rel of sourceFiles(root)) {
    const counts = countSource(fs.readFileSync(path.join(root, rel), 'utf8'));
    if (Object.keys(counts).length > 0) out[rel] = counts;
  }
  return out;
}

export function readBaseline() {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

/**
 * Where the current counts part from the baseline: a count that grew (or a
 * file new to the list), and a count that fell without the baseline following
 * it down. Both must be empty.
 */
export function compare(current, baseline) {
  const grew = [];
  const stale = [];
  for (const file of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    const now = current[file] ?? {};
    const pinned = baseline[file] ?? {};
    for (const kind of new Set([...Object.keys(now), ...Object.keys(pinned)])) {
      const a = now[kind] ?? 0;
      const b = pinned[kind] ?? 0;
      if (a > b) grew.push(`${file}: ${kind} ${b} → ${a}`);
      else if (a < b) stale.push(`${file}: ${kind} ${b} → ${a}`);
    }
  }
  return { grew: grew.sort(), stale: stale.sort() };
}

/** Totals by kind across a count map. */
export function totals(counts) {
  const out = {};
  for (const perFile of Object.values(counts)) {
    for (const [kind, n] of Object.entries(perFile)) out[kind] = (out[kind] ?? 0) + n;
  }
  return out;
}

function main() {
  const current = countTree();
  const write = process.argv.includes('--write');
  const baseline = fs.existsSync(BASELINE_PATH) ? readBaseline() : null;
  const { grew, stale } = baseline ? compare(current, baseline) : { grew: [], stale: [] };
  if (grew.length > 0) {
    console.error('Counts grew past the baseline; build these with the design system instead:');
    for (const line of grew) console.error(`  ${line}`);
    process.exitCode = 1;
    return;
  }
  if (write) {
    const sorted = Object.fromEntries(Object.keys(current).sort().map((file) => [file, current[file]]));
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`Pinned ${Object.keys(sorted).length} files: ${JSON.stringify(totals(sorted))}`);
    return;
  }
  if (stale.length > 0) {
    console.log('Counts fell; pin them with --write:');
    for (const line of stale) console.log(`  ${line}`);
  }
  console.log(`Current: ${JSON.stringify(totals(current))}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
