/**
 * v7 Phase 7 — Block 1: theme-stable accent token coverage.
 *
 * --sage / --sage-dim / --ochre / --terracotta must be defined unconditionally
 * (`:root` + `:root.light`), never scoped by `[data-theme=...]`. That decoupling
 * is what lets sage stay sage in the Plum theme, ochre stay ochre in Moss, etc.
 *
 * This test:
 *   1. Asserts the four accent vars are present in `_shared-accents.css` in
 *      both the dark `:root` block and the light `:root.light` block.
 *   2. Asserts each is a real CSS hex value, not a `var(--primary)` alias.
 *   3. Asserts no theme file (sage.css … terracotta.css) re-declares the
 *      accents inside a `[data-theme=...]` selector.
 *   4. Asserts the @theme inline aliases in `index.css` target the new
 *      stable vars (not `--primary` / `--secondary` / `--tertiary`).
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const UI_ROOT = path.resolve(
  __dirname,
  '..',
  '..',
  'packages',
  'myco',
  'ui',
  'src',
);
const THEMES_DIR = path.join(UI_ROOT, 'themes');
const THEME_FILES = [
  'sage.css',
  'moss.css',
  'terracotta.css',
  'dusk.css',
  'plum.css',
  'slate.css',
];

const ACCENT_VARS = ['--sage', '--sage-dim', '--ochre', '--terracotta'];

function readFile(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/** Extract the body of a CSS rule matching `selector`, or null if missing. */
function extractRuleBody(css: string, selector: string): string | null {
  // Match selector at the beginning of a rule (allow whitespace/newlines after).
  // We escape special characters in selector so consumers can pass literals.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm');
  const match = css.match(re);
  return match ? match[1]! : null;
}

const HEX = /^#[0-9a-fA-F]{3,8}$/;

describe('theme-stable accent tokens (_shared-accents.css)', () => {
  const shared = readFile(path.join(THEMES_DIR, '_shared-accents.css'));

  it('defines each accent in the unconditional :root block', () => {
    const body = extractRuleBody(shared, ':root');
    expect(body, '_shared-accents.css must contain a :root block').not.toBeNull();
    for (const name of ACCENT_VARS) {
      const valueMatch = body!.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
      expect(valueMatch, `:root must declare ${name}`).not.toBeNull();
      expect(
        valueMatch![1]!.trim(),
        `${name} must be a hex literal, not a var() alias (theme-stability)`,
      ).toMatch(HEX);
    }
  });

  it('defines each accent in the :root.light block', () => {
    const body = extractRuleBody(shared, ':root.light');
    expect(body, '_shared-accents.css must contain a :root.light block').not.toBeNull();
    for (const name of ACCENT_VARS) {
      const valueMatch = body!.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
      expect(valueMatch, `:root.light must declare ${name}`).not.toBeNull();
      expect(valueMatch![1]!.trim()).toMatch(HEX);
    }
  });
});

describe('per-theme files do not re-declare accent vars', () => {
  for (const file of THEME_FILES) {
    it(`${file} keeps accent tokens theme-stable`, () => {
      const css = readFile(path.join(THEMES_DIR, file));
      for (const name of ACCENT_VARS) {
        // The accent vars must not appear inside a [data-theme=...] selector
        // in any of the per-theme files — that would re-bind sage to the
        // theme's primary and defeat T1.
        const re = new RegExp(
          `\\[data-theme=[^\\]]+\\][^{]*\\{[^}]*${name}\\s*:`,
          's',
        );
        expect(re.test(css), `${file} must not redefine ${name} inside a [data-theme] rule`).toBe(false);
      }
    });
  }
});

describe('@theme inline aliases (index.css) target stable vars', () => {
  const indexCss = readFile(path.join(UI_ROOT, 'index.css'));
  const body = extractRuleBody(indexCss, '@theme inline');
  it('--color-sage points to --sage, not --primary', () => {
    expect(body).not.toBeNull();
    const match = body!.match(/--color-sage\s*:\s*var\(([^)]+)\)/);
    expect(match, '@theme inline must alias --color-sage').not.toBeNull();
    expect(match![1]!.trim()).toBe('--sage');
  });
  it('--color-ochre points to --ochre, not --secondary', () => {
    const match = body!.match(/--color-ochre\s*:\s*var\(([^)]+)\)/);
    expect(match).not.toBeNull();
    expect(match![1]!.trim()).toBe('--ochre');
  });
  it('--color-terracotta points to --terracotta, not --tertiary', () => {
    const match = body!.match(/--color-terracotta\s*:\s*var\(([^)]+)\)/);
    expect(match).not.toBeNull();
    expect(match![1]!.trim()).toBe('--terracotta');
  });
  it('exposes --color-sage-dim for the gradient consumers', () => {
    const match = body!.match(/--color-sage-dim\s*:\s*var\(([^)]+)\)/);
    expect(match, '@theme inline must alias --color-sage-dim').not.toBeNull();
    expect(match![1]!.trim()).toBe('--sage-dim');
  });
});
