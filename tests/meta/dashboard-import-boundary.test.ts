/**
 * Meta gate: a dashboard's runtime imports reach only what its build carries.
 *
 * A dashboard is built in an image stage that copies its own tree, the shared
 * package whole, and the server's source only by hand-listed file. So a
 * **runtime** import reaching into `../../../src/` resolves on a developer's
 * machine, type-checks, passes every unit test, and then fails the container
 * build — the one place nothing else looks. A **type-only** import is erased
 * before the bundler sees it and is always safe.
 *
 * The rule: a value both a dashboard and the server read at runtime lives in
 * `@goondocks/myco-shared`, which every stage carries. Reaching outside the
 * dashboard's own tree for a value is what this refuses.
 *
 * The second half holds the reason the rule exists rather than the rule alone:
 * a value moved to the shared package must have exactly one definition, or the
 * dashboard and the server drift while both compile.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Every dashboard tree built in an image stage that does not carry the server's source. */
const DASHBOARDS = ['packages/myco-server/ui/src', 'packages/myco/ui/src'];

/**
 * The server files a dashboard's build stage carries by name, and may therefore
 * reach at runtime. Each entry is admitted only while the Dockerfile actually
 * copies it — the assertion below reads the Dockerfile rather than trusting this
 * list, so removing a COPY line fails here instead of in the image build.
 */
const CARRIED_BY_NAME: readonly string[] = ['packages/myco-server/src/read/search-types.ts'];
const DOCKERFILE = 'packages/myco-server/Dockerfile';

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

/** Every import specifier in a file, with whether the import is type-only. */
function imports(source: string): Array<{ from: string; typeOnly: boolean }> {
  const out: Array<{ from: string; typeOnly: boolean }> = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    out.push({ from: m[2]!, typeOnly: /^type\b/.test(m[1]!.trim()) });
  }
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push({ from: m[1]!, typeOnly: false });
  return out;
}

describe('a dashboard reaches only what its build carries', () => {
  it('takes no runtime import from outside its own tree but the shared package', () => {
    const offenders: string[] = [];
    for (const dashboard of DASHBOARDS) {
      let tree: string[];
      try { tree = files(join(ROOT, dashboard)); } catch { continue; }
      for (const file of tree) {
        for (const spec of imports(readFileSync(file, 'utf8'))) {
          // A type-only import is erased before the bundler resolves it.
          if (spec.typeOnly) continue;
          // A relative import that climbs out of the dashboard's own tree.
          if (!spec.from.startsWith('.')) continue;
          if (!spec.from.startsWith('../../../')) continue;
          const reached = `packages/${dashboard.split('/')[1]}/src/${spec.from.replace('../../../src/', '')}`;
          if (CARRIED_BY_NAME.some((carried) => carried === `${reached}.ts` || carried === reached)) continue;
          offenders.push(`${file.slice(ROOT.length)} imports ${spec.from} at runtime`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('carries every server file a dashboard reaches by name, so the exception cannot outlive its COPY', () => {
    const dockerfile = readFileSync(join(ROOT, DOCKERFILE), 'utf8');
    for (const carried of CARRIED_BY_NAME) {
      expect({ carried, copied: dockerfile.includes(`COPY ${carried} `) }).toEqual({ carried, copied: true });
    }
  });

  it('builds every subpath the shared package exports, so a consumer resolving through the map finds one', () => {
    // The build's entry points are the exports map itself. A subpath exported
    // without an output resolves from source everywhere the tests look and
    // fails only where a consumer resolves through the map.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/myco-shared/package.json'), 'utf8')) as { exports: Record<string, { import?: string }> };
    const build = readFileSync(join(ROOT, 'packages/myco-shared/scripts/build.mjs'), 'utf8');
    expect(build).toContain('pkg.exports');
    for (const entry of Object.values(pkg.exports)) {
      if (typeof entry.import !== 'string') continue;
      const source = entry.import.replace(/^\.\/dist\//, 'packages/myco-shared/src/').replace(/\.js$/, '.ts');
      expect({ source, exists: existsSync(join(ROOT, source)) }).toEqual({ source, exists: true });
    }
  });

  it('gives the words a queued run is held by exactly one definition', () => {
    const defined: string[] = [];
    const search = ['packages/myco-server/src', 'packages/myco-server/ui/src', 'packages/myco/src', 'packages/myco/ui/src', 'packages/myco-shared/src'];
    for (const dir of search) {
      let tree: string[];
      try { tree = files(join(ROOT, dir)); } catch { continue; }
      for (const file of tree) {
        if (/const HELD_BY_WORDS\s*[:=]/.test(readFileSync(file, 'utf8'))) defined.push(file.slice(ROOT.length));
      }
    }
    expect(defined).toEqual(['packages/myco-shared/src/run-holds.ts']);
  });
});
