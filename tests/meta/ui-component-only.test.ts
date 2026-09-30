/**
 * Meta gate: outside its design system, the dashboard builds only with the
 * design system.
 *
 * Inside `packages/myco-server/ui/src` but outside `design/`, a file may not
 * gain a raw `<button>`, `<input>`, `<select>`, `<textarea>` or `<table>`, an
 * inline style, a colour literal (hex, a colour function or a named colour), a
 * Tailwind arbitrary colour, a class from Tailwind's default palette, type
 * under 12px, spacing set in pixels or rems off the 4px scale, a width or grid
 * template set in brackets rather than from the tokens, or an import of a
 * retired `components/ui/` file. A raw element
 * counts whether it is written as JSX, through `createElement`, or as a tag
 * name held in a variable or prop. Every kind is at zero in every file, and
 * `ui-component-only.baseline.json` is empty: the ratchet that took each kind
 * down to zero now holds it there, so any new violation fails.
 *
 * `design/` is exempt from the ratchet: it is where the raw `<button>`,
 * `<input>` and `<table>`, the Switch's drawn width and the few bracketed
 * values are wrapped once into the primitives every page uses, so a page never
 * needs them. Its own rule, below, holds it to the tokens instead.
 *
 * Inside `design/`, components size on the 4px tokens: Tailwind's numeric
 * spacing and its rem text sizes resolve against the 14px root, so neither
 * appears there.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compare, countSource, countTree, readBaseline, RULES, sourceFiles, UI_SRC } from '../../scripts/ui-component-ratchet.mjs';

/** One of every violation, each form counted once, with what the counter must find. */
const PLANTED = [
  '<button onClick={go}>Go</button>',
  "createElement('button', null, 'Go');",
  "const Tag = 'button';",
  '<input value={q} />',
  '<select value={v} />',
  '<textarea />',
  '<table><tbody /></table>',
  '<div style={{ width: 4 }} />',
  '<div style={s} />',
  '<div style={ { width: 4 } } />',
  "const tint = '#abcfb8';",
  'const mixed = oklch(0.6 0.1 150);',
  "const named = { color: 'rebeccapurple' };",
  '<span className="bg-[var(--sage)] bg-[oklch(0.5_0.1_20)] text-[rebeccapurple]" />',
  '<span className="bg-red-500 text-white" />',
  '<span className="text-[10px] text-xs" />',
  '<span className="mt-[7px] before:left-[-5px] gap-[2px] -translate-y-[1px] mx-auto min-h-[60vh] max-w-[600px] underline-offset-[3px] p-s4" />',
  '<div className="w-[152px] lg:grid-cols-[208px_minmax(0,1fr)] grid-rows-[auto_1fr]" />',
  '<a className="hover:underline-offset-[3px] decoration-[1.5px]" />',
  "import { Panel } from '../components/ui/panel';",
  "const lazy = import('../components/ui/panel');",
].join('\n');

const PLANTED_COUNTS = {
  'raw-button': 3,
  'raw-input': 1,
  'raw-select': 1,
  'raw-textarea': 1,
  'raw-table': 1,
  'inline-style': 3,
  'colour-literal': 4,
  'arbitrary-colour': 3,
  'palette-colour': 2,
  'small-text': 2,
  'arbitrary-spacing': 4,
  'arbitrary-layout': 4,
  'arbitrary-decoration': 3,
  'retired-import': 2,
};

/** Every source file under the dashboard outside `design/`, found by a glob rather than by the script's own walk. */
function globbed(): string[] {
  return [...new Bun.Glob('**/*.{ts,tsx,css}').scanSync({ cwd: UI_SRC })]
    .map((file) => file.split(path.sep).join('/'))
    .filter((file) => !file.startsWith('design/'))
    .sort();
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-component-only-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('the component-only ratchet', () => {
  it('counts every form of every kind in a planted source, so it cannot pass by matching nothing', () => {
    expect(countSource(PLANTED)).toEqual(PLANTED_COUNTS);
    expect(Object.keys(PLANTED_COUNTS).sort()).toEqual(RULES.map((rule) => rule.kind).sort());
  });

  it('leaves the words a type, role or comparison names alone', () => {
    expect(countSource('<Button type="button" role="button" /> {kind === \'select\' && <Select />}')).toEqual({});
  });

  it('finds a planted file in a tree, exempts the design folder, and compares exactly', () => {
    fs.mkdirSync(path.join(scratch, 'pages'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'design'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'pages', 'Planted.tsx'), '<button />\n<button />');
    fs.writeFileSync(path.join(scratch, 'design', 'Button.tsx'), PLANTED);
    const tree = countTree(scratch);
    expect(tree).toEqual({ 'pages/Planted.tsx': { 'raw-button': 2 } });
    expect(compare(tree, tree)).toEqual({ grew: [], stale: [] });
    expect(compare(tree, {})).toEqual({ grew: ['pages/Planted.tsx: raw-button 0 → 2'], stale: [] });
    expect(compare(tree, { 'pages/Planted.tsx': { 'raw-button': 1 } })).toEqual({ grew: ['pages/Planted.tsx: raw-button 1 → 2'], stale: [] });
    expect(compare(tree, { 'pages/Planted.tsx': { 'raw-button': 3 } })).toEqual({ grew: [], stale: ['pages/Planted.tsx: raw-button 3 → 2'] });
  });

  it('walks every source file outside design/, matching an independent glob', () => {
    const walked = sourceFiles(UI_SRC);
    expect(walked).toEqual(globbed());
    expect(walked.length).toBeGreaterThan(50);
  });

  it('finds no violation anywhere in the dashboard, and pins none', () => {
    // Every kind is at zero in every file: the baseline is empty and stays empty. The planted source and planted tree
    // above prove the scan finds a violation, so an empty result here is the dashboard, not a scan that matched nothing.
    expect(countTree()).toEqual({});
    expect(readBaseline()).toEqual({});
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
