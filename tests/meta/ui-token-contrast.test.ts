/**
 * Meta gate: the dashboard's tokens are complete, and its text is legible.
 *
 * Reads `ui/src/design/tokens.css` and `themes.css` the way a browser applies
 * them — every top-level rule matching the root in a given mode and theme,
 * ordered by specificity and then by source order — and resolves each token to
 * a colour. Three things hold:
 *
 * - every semantic colour token is defined for dark and for light, and every
 *   accent theme sets its accent pair in both modes;
 * - every `var(--…)` the dashboard reads is defined somewhere it can reach;
 * - every pair in PAIRS meets WCAG AA (4.5:1) in every theme and mode,
 *   computed from the token values, with translucent tints composited onto
 *   the surface they sit on.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI_SRC = path.join(REPO, 'packages', 'myco-server', 'ui', 'src');
const DESIGN = path.join(UI_SRC, 'design');
const CSS_FILES = [path.join(DESIGN, 'tokens.css'), path.join(DESIGN, 'themes.css')];

/** The semantic colour tokens; each is set for both modes. */
const SEMANTIC = [
  'page', 'bg', 'surface-1', 'surface-2', 'surface-3', 'line', 'line-strong',
  'ink', 'ink-2', 'muted', 'faint',
  'primary', 'on-primary', 'primary-bg',
  'ok', 'ok-bg', 'warn', 'warn-bg', 'bad', 'bad-bg',
  'focus', 'scrim', 'shadow-overlay',
] as const;

/**
 * Colour properties set on the root in dark only, each with the reason its
 * value holds in light as well. Every other root colour property is set again
 * under `:root.light`.
 */
const MODE_INVARIANT: Record<string, string> = {
  '--on-swatch': 'text on a project swatch, whose hue is fixed and the same in both modes',
  '--shadow-tint': 'the older pages\' ambient shadow is the same warm tint in both modes',
};

/** Every token set as text. Each one is legible on every surface, in every theme and mode. */
const TEXT = ['ink', 'ink-2', 'muted', 'faint', 'primary', 'ok', 'warn', 'bad'] as const;
/** Every opaque surface a component sits on. */
const SURFACES = ['page', 'bg', 'surface-1', 'surface-2', 'surface-3'] as const;

/** Text over ground, both tokens; a translucent ground is composited onto `over`. */
interface Pair { text: string; ground: string; over?: string; min: number }
const AA = 4.5;
const PAIRS: Pair[] = [
  ...TEXT.flatMap((text) => SURFACES.map((ground) => ({ text, ground, min: AA }))),
  ...['ok', 'warn', 'bad'].flatMap((state) => SURFACES.map((over) => ({ text: state, ground: `${state}-bg`, over, min: AA }))),
  ...SURFACES.map((over) => ({ text: 'primary', ground: 'primary-bg', over, min: AA })),
  { text: 'on-primary', ground: 'primary', min: AA },
];

/** Whether a declared value is a colour of its own rather than a reference to other tokens. */
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|^\s*\d+\s*,\s*\d+\s*,\s*\d+\s*$/i;

interface Rule { selector: string; decls: Map<string, string>; order: number }

/** Top-level rules only: a rule inside an at-rule (a media query, `@theme`, `@utility`) is not a root token. */
function topLevelRules(css: string, startOrder: number): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let depth = 0;
  let start = 0;
  let selector = '';
  let order = startOrder;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) { selector = text.slice(start, i).trim(); start = i + 1; }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        if (!selector.startsWith('@')) {
          const decls = new Map<string, string>();
          for (const m of text.slice(start, i).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls.set(m[1]!, m[2]!.trim());
          for (const sel of selector.split(',').map((s) => s.trim())) rules.push({ selector: sel, decls, order: order++ });
        }
        start = i + 1;
      }
    }
  }
  return rules;
}

const RULES = CSS_FILES.flatMap((file, index) => topLevelRules(fs.readFileSync(file, 'utf8'), index * 10_000));

const THEMES = (() => {
  const source = fs.readFileSync(path.join(UI_SRC, 'lib', 'appearance-values.ts'), 'utf8');
  const list = /APPEARANCE_THEMES\s*=\s*\[([^\]]+)\]/.exec(source)?.[1] ?? '';
  return [...list.matchAll(/'([\w-]+)'/g)].map((m) => m[1]!);
})();

/** Whether a root selector applies to the root in this mode and theme. */
function applies(selector: string, light: boolean, theme: string): boolean {
  if (!selector.startsWith(':root')) return false;
  const rest = selector.slice(':root'.length);
  for (const part of rest.match(/\.[\w-]+|\[[^\]]+\]/g) ?? []) {
    if (part === '.light') { if (!light) return false; continue; }
    const attr = /^\[data-theme=['"]?([\w-]+)['"]?\]$/.exec(part);
    if (attr) { if (attr[1] !== theme) return false; continue; }
    return false;
  }
  return rest.replace(/\.[\w-]+|\[[^\]]+\]/g, '') === '';
}

const specificity = (selector: string): number => (selector.match(/\.[\w-]+|\[[^\]]+\]|:root/g) ?? []).length;

function tokensFor(light: boolean, theme: string): Map<string, string> {
  const out = new Map<string, string>();
  const matching = RULES.filter((rule) => applies(rule.selector, light, theme))
    .sort((a, b) => specificity(a.selector) - specificity(b.selector) || a.order - b.order);
  for (const rule of matching) for (const [name, value] of rule.decls) out.set(name, value);
  return out;
}

/** Root colour properties set in dark with no light counterpart and no stated reason. */
function colourGaps(rules: Rule[]): string[] {
  const light = new Set(rules.filter((r) => r.selector === ':root.light').flatMap((r) => [...r.decls.keys()]));
  const gaps: string[] = [];
  for (const rule of rules.filter((r) => r.selector === ':root')) {
    for (const [name, value] of rule.decls) {
      if (!COLOUR_LITERAL.test(value) || light.has(name) || name in MODE_INVARIANT) continue;
      gaps.push(`:root ${name}`);
    }
  }
  return gaps;
}

type Rgba = [number, number, number, number];

function resolveVars(value: string, tokens: Map<string, string>, depth = 0): string {
  if (depth > 20) throw new Error(`token cycle at ${value}`);
  return value.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_, name: string, fallback?: string) => {
    const found = tokens.get(name) ?? fallback;
    if (found === undefined) throw new Error(`${name} is not defined`);
    return resolveVars(found, tokens, depth + 1);
  });
}

function parseColour(raw: string): Rgba {
  const value = raw.trim();
  if (value === 'transparent') return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(value);
  if (mix) {
    const a = parseColour(mix[1]!);
    const b = parseColour(mix[3]!);
    const p = Number(mix[2]) / 100;
    const alpha = a[3] * p + b[3] * (1 - p);
    if (alpha === 0) return [0, 0, 0, 0];
    const channel = (i: number) => (a[i]! * a[3] * p + b[i]! * b[3] * (1 - p)) / alpha;
    return [channel(0), channel(1), channel(2), alpha];
  }
  throw new Error(`not a colour this gate reads: ${value}`);
}

function colour(name: string, tokens: Map<string, string>): Rgba {
  const value = tokens.get(`--${name}`);
  if (value === undefined) throw new Error(`--${name} is not defined`);
  return parseColour(resolveVars(value, tokens));
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('design tokens', () => {
  it('reads the six accent themes and both modes (guards against a silently empty parse)', () => {
    expect(THEMES).toEqual(['sage', 'moss', 'terracotta', 'dusk', 'plum', 'slate']);
    expect(RULES.filter((rule) => rule.selector === ':root').length).toBeGreaterThan(0);
    expect(RULES.filter((rule) => rule.selector === ':root.light').length).toBe(1);
  });

  it('defines every semantic colour token for dark and for light', () => {
    const dark = new Set(RULES.filter((r) => r.selector === ':root').flatMap((r) => [...r.decls.keys()]));
    const light = new Set(RULES.filter((r) => r.selector === ':root.light').flatMap((r) => [...r.decls.keys()]));
    const missing = SEMANTIC.flatMap((name) => [
      ...(dark.has(`--${name}`) ? [] : [`dark --${name}`]),
      ...(light.has(`--${name}`) ? [] : [`light --${name}`]),
    ]);
    expect(missing).toEqual([]);
  });

  it('sets every colour it gives the dark root again for light, or names why it holds in both', () => {
    const darkOnly = colourGaps(RULES);
    expect(darkOnly).toEqual([]);
    for (const name of Object.keys(MODE_INVARIANT)) {
      expect({ name, declared: RULES.some((r) => r.selector === ':root' && r.decls.has(name)) }).toEqual({ name, declared: true });
    }
  });

  it('catches a colour set for dark alone', () => {
    const planted = topLevelRules(':root { --planted: #123456; --derived: var(--bg); } :root.light { --derived: var(--bg); }', 0);
    expect(colourGaps(planted)).toEqual([':root --planted']);
  });

  it('sets every colour of a theme in both modes, and the accent pair in each', () => {
    const missing: string[] = [];
    for (const theme of THEMES) {
      const dark = RULES.find((r) => r.selector === `:root[data-theme='${theme}']`);
      const light = RULES.find((r) => r.selector === `:root[data-theme='${theme}'].light`);
      for (const name of ['--primary', '--on-primary']) {
        if (!dark?.decls.has(name)) missing.push(`${theme} dark ${name}`);
        if (!light?.decls.has(name)) missing.push(`${theme} light ${name}`);
      }
      for (const name of dark?.decls.keys() ?? []) if (!light?.decls.has(name)) missing.push(`${theme} light ${name}`);
    }
    expect(missing).toEqual([]);
  });

  it('resolves every semantic token to a colour in every theme and mode', () => {
    for (const theme of THEMES) {
      for (const light of [false, true]) {
        const tokens = tokensFor(light, theme);
        for (const name of SEMANTIC) {
          if (name === 'shadow-overlay') continue;
          expect(() => colour(name, tokens)).not.toThrow();
        }
      }
    }
  });

  it('meets AA for every listed pair in every theme and mode', () => {
    const failures: string[] = [];
    for (const theme of THEMES) {
      for (const light of [false, true]) {
        const tokens = tokensFor(light, theme);
        for (const pair of PAIRS) {
          const base = pair.over ? colour(pair.over, tokens) : ([0, 0, 0, 1] as Rgba);
          const ground = over(colour(pair.ground, tokens), base);
          const text = over(colour(pair.text, tokens), ground);
          const ratio = contrast(text, ground);
          if (ratio < pair.min) {
            failures.push(`${theme} ${light ? 'light' : 'dark'}: --${pair.text} on --${pair.ground}${pair.over ? ` over --${pair.over}` : ''} is ${ratio.toFixed(2)}:1, needs ${pair.min}:1`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('catches a pair that fails, so the check is not vacuous', () => {
    const tokens = new Map([['--a', '#7a8576'], ['--b', '#262d22']]);
    expect(contrast(colour('a', tokens), colour('b', tokens))).toBeLessThan(AA);
  });
});

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('every token the dashboard reads', () => {
  it('is defined in its CSS, set by the appearance code, or supplied by Tailwind or Radix', () => {
    const files = sources(UI_SRC);
    const defined = new Set<string>();
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]!);
      for (const m of text.matchAll(/setProperty\(\s*['"](--[\w-]+)['"]/g)) defined.add(m[1]!);
    }
    const undefinedReads: string[] = [];
    for (const file of files) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/var\((--[\w-]+)\s*(,)?/g)) {
          const name = m[1]!;
          if (m[2] === ',' || defined.has(name) || /^--(tw|radix)-/.test(name)) continue;
          undefinedReads.push(`${path.relative(UI_SRC, file)}:${i + 1} ${name}`);
        }
      });
    }
    expect(files.length).toBeGreaterThan(20);
    expect(undefinedReads).toEqual([]);
  });
});
