/** The 2.0 closure has no 1.4 crossings except the pending CLI dispatch and checkpoint removals. */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  filesUnder, moduleKey, REPO_ROOT, pathToEntry, closureOf, type Closure,
} from '../helpers/import-closure.ts';

import { walk, walkMemberRuntime, isLegacyVerb } from '../helpers/2-0-closure.ts';
import { LEGACY_DIRS, LEGACY_FILES, isLegacy } from '../helpers/legacy-boundary.ts';

const SRC = path.join(REPO_ROOT, 'packages', 'myco', 'src');
const MYCO = 'packages/myco/src/';

/**
 * Every edge from 2.0 code into the 1.4 tree, `importer -> imported` (paths under `packages/myco/src`), with the #1170
 * phase that removes it. An edge from `cli.ts` to a 1.4 verb module is the verb's dispatch and is allowed by rule.
 */
const ALLOWED_EDGES: Readonly<Record<string, string>> = {};

/** Retained CLI edges whose dispatch and checkpoint are removed together. */
const PR3_EDGES: Readonly<Record<string, string>> = {
  'cli.ts -> backup/pre-migration-checkpoint.ts': '#1170 P4: PR 3 removes the pre-migration checkpoint from the 2.0 verbs',
  'cli.ts -> vault/resolve.ts': '#1170 P3: vault/resolve moves into project-root.ts',
};

/** The 2.0 files under `packages/myco/src` nothing in the walk imports, each with how it is used. */
const UNREACHED_2_0: Readonly<Record<string, string>> = {
  'runtime/bun-sqlite.d.ts': 'type declarations, which load nothing',
  'skills/contamination.ts': "read by `lint:skills` and the shipped skills' contract, never by the binary",
  'symbionts/templates/cline/plugin.ts': 'a member plugin, embedded as text by `symbionts/templates.generated.ts`',
  'symbionts/templates/opencode/plugin.ts': 'a member plugin, embedded as text by `symbionts/templates.generated.ts`',
  'symbionts/templates/pi/plugin.ts': 'a member plugin, embedded as text by `symbionts/templates.generated.ts`',
};

/**
 * The modules in the 2.0 closure whose text holds a call the walk reads as a non-literal `import()` or `require()`, with
 * how many. Each is text another program runs, not an import of this one's.
 */
const UNFOLLOWABLE: Readonly<Record<string, number>> = {
  // The member plugins' and launchers' text, written into an agent's own configuration.
  'packages/myco/src/symbionts/templates.generated.ts': 4,
};

/**
 * Every place outside the source a 1.4 path is named, `<file> <path it names>`, with the #1170 phase that removes it:
 * the `package.json` scripts, the Dockerfiles, the Makefile and the CI workflows and actions.
 */
const ALLOWED_TEXT_REACH: Readonly<Record<string, string>> = {
};

const short = (key: string): string => (key.startsWith(MYCO) ? key.slice(MYCO.length) : key);

/** Every edge a closure crossed from code outside the 1.4 tree into it, but the CLI's dispatch to a 1.4 verb. */
function crossings(closure: Closure): string[] {
  const out: string[] = [];
  for (const [from, imported] of closure.edges) {
    if (isLegacy(from)) continue;
    for (const to of imported) {
      if (!isLegacy(to) || (from === `${MYCO}cli.ts` && isLegacyVerb(to))) continue;
      out.push(`${short(from)} -> ${short(to)}`);
    }
  }
  return out;
}

/** The files a 1.4 path may be named in, outside the source: scripts, Dockerfiles, the Makefile and CI. */
function textFiles(): string[] {
  const packages = path.join(REPO_ROOT, 'packages');
  const manifests = ['package.json', ...fs.readdirSync(packages).flatMap((dir) => [`packages/${dir}/package.json`, `packages/${dir}/ui/package.json`, `packages/${dir}/worker/package.json`])];
  const dockerfiles = fs.readdirSync(packages).flatMap((dir) => fs.existsSync(path.join(packages, dir))
    ? fs.readdirSync(path.join(packages, dir)).filter((name) => name.startsWith('Dockerfile')).map((name) => `packages/${dir}/${name}`)
    : []);
  const yaml = (dir: string): string[] => (fs.existsSync(path.join(REPO_ROOT, dir))
    ? filesIn(path.join(REPO_ROOT, dir)).filter((file) => /\.ya?ml$/.test(file)).map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
    : []);
  return [...manifests, ...dockerfiles, 'Makefile', ...yaml('.github/workflows'), ...yaml('.github/actions')]
    .filter((file) => fs.existsSync(path.join(REPO_ROOT, file)));
}

function filesIn(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesIn(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

/** The text a file holds that runs: a manifest's scripts, every other file whole. */
function runnableText(file: string): string {
  const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8');
  if (!file.endsWith('package.json')) return text;
  return Object.values((JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {}).join('\n');
}

/** Every 1.4 path a file names, resolved from the file's own folder and from the repository root. */
function legacyPathsIn(file: string): string[] {
  const found = new Set<string>();
  for (const [token] of runnableText(file).matchAll(/[\w.@~*/-]*src\/[\w.@*/-]*/g)) {
    for (const base of [path.dirname(file), '.']) {
      const resolved = path.posix.normalize(path.posix.join(base, token)).replace(/\/+$/, '');
      const legacy = resolved.startsWith(MYCO) && (isLegacy(resolved) || LEGACY_DIRS.some((dir) => resolved === `${MYCO}${dir}`));
      if (legacy) found.add(resolved);
    }
  }
  return [...found];
}

describe('the 2.0 code', () => {
  it('imports no edge at all into the 1.4 tree outside retained PR 3 CLI carriers', () => {
    const { myco, server } = walk();
    // An `import(expr)` names no module the walk can follow, so each one in the 2.0 closure is named here: none of them is code.
    expect(Object.fromEntries([...myco.unknowable, ...server.unknowable])).toEqual(UNFOLLOWABLE);
    const found = [...new Set([...crossings(myco), ...crossings(server)])].sort();
    expect(ALLOWED_EDGES).toEqual({});
    const named = Object.keys(PR3_EDGES).sort();
    expect(found.filter((edge) => !named.includes(edge)), 'a new edge from 2.0 code into the 1.4 tree').toEqual([]);
    expect(named.filter((edge) => !found.includes(edge)), 'a named edge that no longer exists: delete its row').toEqual([]);
  }, 120_000);

  it('leaves no file under packages/myco/src unaccounted for: each is reached, inside the 1.4 tree, or named', () => {
    const { myco } = walk();
    const loose = filesUnder(SRC).map(moduleKey).filter((key) => !myco.modules.has(key) && !isLegacy(key)).map(short).sort();
    expect(loose.filter((file) => !(file in UNREACHED_2_0)), 'a file nothing 2.0 reaches and the 1.4 tree does not hold: name it, or mark it 1.4').toEqual([]);
    expect(Object.keys(UNREACHED_2_0).filter((file) => !loose.includes(file)), 'a named file the walk now reaches or the 1.4 tree holds: delete its row').toEqual([]);
    // A 1.4 entry names a file or directory that is there: a boundary that names nothing closes nothing.
    const gone = [...LEGACY_FILES.filter((file) => !fs.existsSync(path.join(SRC, file))), ...LEGACY_DIRS.filter((dir) => !fs.existsSync(path.join(SRC, dir)))];
    expect(gone, 'a 1.4 entry whose file is gone: delete it').toEqual([]);
  }, 120_000);

  it('names no 1.4 path in a script, a Dockerfile, the Makefile or CI but the ones listed', () => {
    const found = textFiles().flatMap((file) => legacyPathsIn(file).map((named) => `${file} ${named}`)).sort();
    const listed = Object.keys(ALLOWED_TEXT_REACH).sort();
    expect(found.filter((entry) => !listed.includes(entry)), 'a new 1.4 path named outside the source').toEqual([]);
    expect(listed.filter((entry) => !found.includes(entry)), 'a listed 1.4 path no longer named: delete its row').toEqual([]);
  });

  it('names, for every edge and every path it allows, the #1170 phase that removes it', () => {
    for (const [entry, phase] of Object.entries({ ...PR3_EDGES, ...ALLOWED_TEXT_REACH })) {
      expect({ entry, phase }).toEqual({ entry, phase: expect.stringMatching(/^#1170 P(?:[1-9]|1[0-2])[ab]?: \S/) });
    }
  });
});

const forbiddenRuntime = (key: string): boolean => key.startsWith(`${MYCO}daemon/`)
  || key.startsWith(`${MYCO}db/`) || key === `${MYCO}grove/request-context.ts`;

it('no 2.0 module directly imports a daemon, database or Grove request-context module', () => {
  const { myco, server } = walk();
  for (const closure of [myco, server]) {
    expect([...closure.modules.keys()].filter(forbiddenRuntime).map(key => pathToEntry(closure, key))).toEqual([]);
  }
}, 120_000);

/** The retained carriers of forbidden runtime modules, with the PR that removes each edge. */
const RUNTIME_CARRIERS: Readonly<Record<string, string>> = {
  'cli.ts -> backup/pre-migration-checkpoint.ts': 'PR 3',
};

/** All paths reachable without a named carrier, including alternate paths into shared leaves. */
function uncarriedRuntime(closure: Closure, carriers: Readonly<Record<string, string>> = {}): string[][] {
  const via = new Map<string, string | null>([...closure.via].filter(([, importer]) => importer === null));
  const queue = [...via.keys()];
  for (const from of queue) {
    for (const to of closure.edges.get(from) ?? []) {
      if (`${short(from)} -> ${short(to)}` in carriers || via.has(to)) continue;
      via.set(to, from);
      queue.push(to);
    }
  }
  return [...via.keys()].filter(forbiddenRuntime).map(key => pathToEntry({ ...closure, via }, key));
}

it('transitive runtime reach requires a named carrier and its retiring PR', () => {
  const { myco, server } = walk(undefined, isLegacyVerb);
  for (const edge of Object.keys(RUNTIME_CARRIERS)) {
    const [from, to] = edge.split(' -> ');
    expect(myco.edges.get(MYCO + from)?.has(MYCO + to), `retired carrier: delete ${edge}`).toBe(true);
  }
  expect(uncarriedRuntime(myco, RUNTIME_CARRIERS)).toEqual([]);
  expect(uncarriedRuntime(server)).toEqual([]);
}, 120_000);

it('hooks, member code and MCP have no transitive daemon, database or Grove request-context dependency', () => {
  expect(uncarriedRuntime(walkMemberRuntime())).toEqual([]);
}, 120_000);

it('rejects a forbidden runtime import hidden behind the shared capture boundary', () => {
  const mutate = (file: string, text: string): string => file.endsWith('/member/buffer.ts')
    ? `import '@myco/daemon/client.js';\n${text}` : text;
  expect(uncarriedRuntime(walk(mutate, isLegacyVerb).myco, RUNTIME_CARRIERS)
    .some(chain => chain.at(-1) === MYCO + 'daemon/client.ts')).toBe(true);
  expect(uncarriedRuntime(walkMemberRuntime(mutate))
    .some(chain => chain.at(-1) === MYCO + 'daemon/client.ts')).toBe(true);
}, 120_000);

it('rejects restored runtime imports at the 1.4 boundary', () => {
  for (const target of ['daemon/client.ts', 'db/schema.ts', 'grove/request-context.ts']) {
    const { myco } = walk((file, text) => file.endsWith('/mcp/stdio-bridge.ts')
      ? `import '@myco/${target}';\n${text}` : text);
    expect([...myco.modules.keys()].filter(forbiddenRuntime)).toContain(`${MYCO}${target}`);
  }
}, 120_000);

/** Migration administration is retained 2.0 code, including every legacy helper entry. */
function migrationClosure(mutate?: (file: string, text: string) => string): Closure {
  const roots = filesUnder(SRC).filter(file => {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    return relative === 'cli/cutover.ts' || relative.startsWith('member/legacy-');
  });
  return closureOf(roots, { source: mutate });
}

it('cutover and every member legacy helper are retained and reach no 1.4 module', () => {
  const { myco } = walk();
  const retained = migrationClosure();
  expect(retained.modules.has(MYCO + 'cli/cutover.ts')).toBe(true);
  expect([...retained.via].filter(([, parent]) => parent === null).every(([key]) => myco.modules.has(key))).toBe(true);
  expect([...retained.modules.keys()].filter(isLegacy).map(key => pathToEntry(retained, key))).toEqual([]);
}, 120_000);

it('rejects direct and transitive 1.4 imports in retained migration administration', () => {
  for (const importer of ['cli/cutover.ts', 'member/legacy-daemon-stop.ts', 'member/legacy-service/windows.ts']) {
    const mutated = migrationClosure((file, text) => file.endsWith('/' + importer)
      ? "import '@myco/service/home-daemon.js';\n" + text : text);
    expect([...mutated.modules.keys()].filter(isLegacy)).toContain(MYCO + 'service/home-daemon.ts');
  }
}, 120_000);
