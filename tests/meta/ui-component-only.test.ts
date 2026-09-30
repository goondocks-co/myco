/**
 * Meta gate: outside its design system, the dashboard builds only with the
 * design system.
 *
 * Inside `packages/myco-server/ui/src` but outside `design/`, a file may not
 * gain a raw `<button>`, `<input>`, `<select>`, `<textarea>` or `<table>`, an
 * inline style, a colour literal, a Tailwind arbitrary colour, type under
 * 12px, or an import of a retired `components/ui/` file. Today's violations are
 * pinned per file in `ui-component-only.baseline.json`; a count may only go
 * down, and the baseline follows it down (`node scripts/ui-component-ratchet.mjs
 * --write`). A file not in the baseline starts at zero.
 *
 * Inside `design/`, components size on the 4px tokens: Tailwind's numeric
 * spacing and its rem text sizes resolve against the 14px root, so neither
 * appears there.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compare, countSource, countTree, readBaseline, RULES, UI_SRC } from '../../scripts/ui-component-ratchet.mjs';

const PLANTED = [
  '<button onClick={go}>Go</button>',
  '<input value={q} />',
  '<select value={v} />',
  '<textarea />',
  '<table><tbody /></table>',
  '<div style={{ width: 4 }} />',
  "const tint = '#abcfb8';",
  '<span className="bg-[var(--sage)] text-[10px] text-xs" />',
  "import { Panel } from '../components/ui/panel';",
].join('\n');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-component-only-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('the component-only ratchet', () => {
  it('counts every kind it names in a planted source, so it cannot pass by matching nothing', () => {
    const counts = countSource(PLANTED);
    for (const rule of RULES) expect({ kind: rule.kind, found: (counts[rule.kind] ?? 0) > 0 }).toEqual({ kind: rule.kind, found: true });
    expect(counts['small-text']).toBe(2);
  });

  it('finds a planted file in a tree and exempts the design folder', () => {
    fs.mkdirSync(path.join(scratch, 'pages'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'design'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'pages', 'Planted.tsx'), PLANTED);
    fs.writeFileSync(path.join(scratch, 'design', 'Button.tsx'), PLANTED);
    const tree = countTree(scratch);
    expect(Object.keys(tree)).toEqual(['pages/Planted.tsx']);
    expect(compare(tree, {}).grew.length).toBeGreaterThan(0);
  });

  it('scans the real dashboard (guards against a silently empty scan)', () => {
    expect(Object.keys(countTree()).length).toBeGreaterThan(20);
  });

  it('holds every file at or under its pinned count, and a new file at zero', () => {
    const { grew } = compare(countTree(), readBaseline());
    expect(grew, 'build these with the components in ui/src/design instead').toEqual([]);
  });

  it('keeps the baseline at the current counts, so a fixed violation cannot come back', () => {
    const { stale } = compare(countTree(), readBaseline());
    expect(stale, 'counts fell: run `node scripts/ui-component-ratchet.mjs --write` and commit the baseline').toEqual([]);
  });
});

/** Tailwind utilities whose numeric steps are rem multiples of the 14px root. */
const REM_SPACING = /(?<![\w-])-?(?:p[xytrbl]?|m[xytrbl]?|gap(?:-[xy])?|space-[xy]|w|h|size|min-w|min-h|max-w|max-h|top|left|right|bottom|inset(?:-[xy])?|translate-[xy]|basis)-(?!0\b)\d+(?:\.\d+)?(?![\w/.%-])/g;
const REM_TEXT = /(?<![\w-])text-(?:xs|sm|base|lg|[2-9]?xl)(?![\w-])/g;

function designFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) designFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('the design system sizes on its own tokens', () => {
  it('catches a planted rem size', () => {
    expect('<span className="h-5 w-9 p-4 text-sm size-4" />'.match(REM_SPACING)?.length).toBe(4);
    expect('<span className="text-sm" />'.match(REM_TEXT)?.length).toBe(1);
    expect('<span className="h-s5 w-[36px] p-0 w-1/2 -translate-y-1/2 t-small" />'.match(REM_SPACING)).toBeNull();
  });

  it('uses no rem-based spacing or text size inside ui/src/design', () => {
    const files = designFiles(path.join(UI_SRC, 'design'));
    expect(files.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const file of files) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const m of [...line.matchAll(REM_SPACING), ...line.matchAll(REM_TEXT)]) hits.push(`${path.relative(UI_SRC, file)}:${i + 1} ${m[0]}`);
      });
    }
    expect(hits, 'size with the s-1…s-12 tokens, h-control/h-row, or t-* type').toEqual([]);
  });
});
