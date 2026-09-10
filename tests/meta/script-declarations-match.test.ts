/**
 * Every hand-written `.d.mts` beside a `.mjs` script declares that module's
 * exports, all of them and nothing else.
 *
 * The two build scripts under `packages/myco/scripts/` are plain JavaScript
 * that TypeScript callers import — `gen-plugin-bundle.ts` pulls from
 * `codegen-bundle.mjs`, and `tests/install/select-binary-converge.test.ts`
 * pulls from `select-binary.mjs`. Their declarations are a second copy of the
 * export list by hand, so an export renamed in the module, or one added and
 * never declared, would drift silently: the declaration would keep compiling
 * and the import would resolve to nothing at runtime.
 *
 * This holds the two lists equal by name. It does not check the signatures —
 * a `.mjs` has none to check against — so a changed parameter list is still on
 * the reader. The names are what a caller resolves.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = fileURLToPath(new URL('../../packages/myco/scripts/', import.meta.url));

/** The names a module exports, read from its `export function`/`export const` declarations. */
function exportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]!);
  }
  for (const match of source.matchAll(/^export\s+\{([^}]*)\}/gm)) {
    for (const part of match[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

/** Every `.d.mts` under the scripts directory, paired with the module it declares. */
const pairs = fs.readdirSync(SCRIPTS)
  .filter((name) => name.endsWith('.d.mts'))
  .map((declaration) => ({
    declaration,
    module: `${declaration.slice(0, -'.d.mts'.length)}.mjs`,
  }));

describe('script declarations', () => {
  test('there is at least one to hold, so this gate cannot pass by finding nothing', () => {
    expect(pairs.length).toBeGreaterThan(0);
  });

  test('each declaration names the module it sits beside', () => {
    for (const { declaration, module } of pairs) {
      expect({ declaration, module, present: fs.existsSync(path.join(SCRIPTS, module)) })
        .toEqual({ declaration, module, present: true });
    }
  });

  test('each declaration exports exactly what its module exports', () => {
    for (const { declaration, module } of pairs) {
      const declared = exportedNames(fs.readFileSync(path.join(SCRIPTS, declaration), 'utf-8'));
      const actual = exportedNames(fs.readFileSync(path.join(SCRIPTS, module), 'utf-8'));
      expect({ module, exports: declared }).toEqual({ module, exports: actual });
    }
  });
});
