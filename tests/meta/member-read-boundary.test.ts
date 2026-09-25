/**
 * Meta gate: a retained verb run for a joined project reaches no local-runtime
 * code.
 *
 * In a joined project, `search`, `vectors`, `session` and `stats` are answered by
 * the Deployment (`cli/member-reads.ts`), and `doctor`, `logs` and `config` are
 * the member's own (`cli/member-doctor.ts`, `cli/member-logs.ts`,
 * `cli/member-config.ts`), all entered through `cli/member-dispatch.ts`. A module
 * in that import closure that opens a vault, a Grove database or the daemon is
 * a second implementation beside the member's, and on a machine with no 1.4
 * install it fails or creates legacy state. The closure is walked, not grepped:
 * a forbidden import two hops deep compiles into the same verb as a direct one
 * (`tests/helpers/import-closure.ts`).
 *
 * Two strengths. The read handler reaches nothing local at all. The machine
 * verbs read the harnesses' configuration through the one symbiont installer
 * and the worker service through `cli/worker-service.ts`, and those shared
 * modules reach a fixed set of 1.4 leaves — path arithmetic, the config schema
 * and loader, service labels — none of which the member verbs call. That set is
 * listed by module in `SHARED_LEGACY_LEAVES`; it only shrinks, and a module that
 * leaves the closure must leave the list. Nothing else under a local-runtime
 * tree may appear, and no member verb module imports one directly.
 *
 * The dispatcher half: every member verb is a verb `cli.ts` dispatches, and the
 * branch that routes it to the member sits above the `myco.yaml` gate, so a
 * joined checkout with no vault is never asked for one.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { MEMBER_READ_VERBS, MEMBER_VERBS } from '@myco/cli/member-verbs.js';
import { closureOf, pathToEntry, REPO_ROOT, runtimeEdges } from '../helpers/import-closure.ts';

const SRC = 'packages/myco/src';

/** The Deployment-answered read handler. */
const READ_ENTRY = `${SRC}/cli/member-reads.ts`;
/** The entry every member verb runs through. */
const DISPATCH_ENTRY = `${SRC}/cli/member-dispatch.ts`;

/** The modules that make up the member verbs themselves. */
const MEMBER_VERB_MODULES: readonly string[] = [
  'cli/member-dispatch.ts', 'cli/member-verbs.ts', 'cli/member-reads.ts', 'cli/member-doctor.ts', 'cli/member-logs.ts',
  'cli/member-config.ts', 'cli/deployment-reader.ts', 'cli/doctor-member.ts', 'mcp/client-call.ts',
].map((file) => `${SRC}/${file}`);

/** Local-runtime code, by tree or module: the vault, Grove databases, the daemon and its service, Team Host, backups, the 1.4 agent, config and logs. */
const FORBIDDEN: readonly string[] = [
  `${SRC}/daemon/`, `${SRC}/grove/`, `${SRC}/vault/`, `${SRC}/db/`, `${SRC}/host/`, `${SRC}/team/`, `${SRC}/team-host/`, `${SRC}/service/`,
  `${SRC}/backup/`, `${SRC}/services/`, `${SRC}/agent/`, `${SRC}/intelligence/`, `${SRC}/config/`, `${SRC}/logs/`,
  `${SRC}/cli/shared.ts`, `${SRC}/cli/tool.ts`, `${SRC}/cli/doctor.ts`, `${SRC}/mcp/stdio-bridge.ts`, `${SRC}/tools/`,
];

/**
 * The 1.4 leaves the machine verbs reach through shared modules, and the shared
 * module that brings each in. None opens a database or writes a vault on import.
 */
const SHARED_LEGACY_LEAVES: Readonly<Record<string, string>> = {
  [`${SRC}/grove/paths.ts`]: 'home-directory path arithmetic, via symbionts/detect.ts and cli/worker-service.ts',
  [`${SRC}/grove/ids.ts`]: 'branded id types, via grove/paths.ts',
  [`${SRC}/grove/registry-resolve.ts`]: 'via config/project-manifest.ts',
  [`${SRC}/grove/subsystem-claim.ts`]: 'via symbionts/installer.ts',
  [`${SRC}/daemon/update-checker.ts`]: 'via symbionts/installer.ts',
  [`${SRC}/vault/gitignore.ts`]: 'via config/project-manifest.ts',
  [`${SRC}/config/loader.ts`]: 'via symbionts/installer.ts',
  [`${SRC}/config/schema.ts`]: 'via config/loader.ts',
  [`${SRC}/config/appearance-values.ts`]: 'via config/schema.ts',
  [`${SRC}/config/capabilities.ts`]: 'via config/loader.ts',
  [`${SRC}/config/leaf-paths.ts`]: 'via config/loader.ts',
  [`${SRC}/config/migrations.ts`]: 'via config/loader.ts',
  [`${SRC}/config/project-manifest.ts`]: 'via config/loader.ts',
  [`${SRC}/config/scope.ts`]: 'via config/loader.ts',
  [`${SRC}/config/sparse.ts`]: 'via config/loader.ts',
  [`${SRC}/service/spec-builder.ts`]: 'a dev-build check, via cli/worker-service.ts',
  [`${SRC}/service/labels.ts`]: 'via service/spec-builder.ts',
  [`${SRC}/service/paths.ts`]: 'via service/spec-builder.ts',
};

/** The packages the read handler may import: the MCP client that calls the served tools. */
const READ_EXTERNALS: readonly string[] = ['@modelcontextprotocol/client'];

const isForbidden = (key: string): boolean => FORBIDDEN.some((prefix) => key === prefix || key.startsWith(prefix));

function reached(entry: string) {
  const closure = closureOf([path.join(REPO_ROOT, entry)]);
  const forbidden = [...closure.modules.keys()].filter(isForbidden);
  return { closure, forbidden, chain: (key: string) => pathToEntry(closure, key).join(' → ') };
}

describe('the member verbs reach no local-runtime code', () => {
  it(`${READ_ENTRY} reaches no local-runtime module and no package but the MCP client, at any depth`, () => {
    const { closure, forbidden, chain } = reached(READ_ENTRY);
    const externals = [...closure.externals].filter(([name]) => !READ_EXTERNALS.includes(name)).map(([name, via]) => `${via} → ${name}`);
    const unknowable = [...closure.unknowable].map(([key, n]) => `${key}: ${n} non-literal import(s)`);
    expect([...forbidden.map(chain), ...externals, ...unknowable]).toEqual([]);
  });

  it(`${DISPATCH_ENTRY} reaches no local-runtime module beyond the listed shared leaves, and every listed leaf is still reached`, () => {
    const { forbidden, chain } = reached(DISPATCH_ENTRY);
    expect(forbidden.filter((key) => SHARED_LEGACY_LEAVES[key] === undefined).map(chain)).toEqual([]);
    expect(Object.keys(SHARED_LEGACY_LEAVES).filter((key) => !forbidden.includes(key))).toEqual([]);
  });

  it('no member verb module imports a local-runtime module directly', () => {
    const direct: string[] = [];
    for (const file of MEMBER_VERB_MODULES) {
      const closure = closureOf([path.join(REPO_ROOT, file)]);
      for (const [key, via] of closure.via) if (via === file && isForbidden(key)) direct.push(`${file} → ${key}`);
      expect(runtimeEdges(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'), file).unknowableDynamic).toBe(0);
    }
    expect(direct).toEqual([]);
  });

  it('sees a violation where one exists: the 1.4 search handler reaches the local database', () => {
    expect(reached(`${SRC}/cli/search.ts`).forbidden.some((key) => key.startsWith(`${SRC}/db/`))).toBe(true);
  });
});

describe('the dispatcher routes the member verbs above the myco.yaml gate', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, SRC, 'cli.ts'), 'utf8');
  const routed = cli.indexOf('if (isMemberVerb(cmd))');
  const gate = cli.indexOf("path.join(vaultDir, 'myco.yaml')");

  it('the member branch precedes the vault gate', () => {
    expect(routed).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(routed).toBeLessThan(gate);
  });

  it('the Deployment-read verbs are exactly the §7.1 CLI rows the ledger names as answered by the Deployment', () => {
    const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'architecture', 'myco-2.0.md'), 'utf8');
    const section = doc.slice(doc.indexOf('### 7.1 CLI commands'), doc.indexOf('### 7.2 '));
    const ledger = [...section.matchAll(/^\| `([^`]+)` \|[^\n]*`cli\/member-reads\.ts`[^\n]*$/gm)].map((m) => m[1]).sort();
    expect(ledger.length).toBeGreaterThan(0);
    expect([...MEMBER_READ_VERBS].sort() as string[]).toEqual(ledger);
  });

  it.each([...MEMBER_VERBS])('%s is a verb the dispatcher knows', (verb) => {
    expect(cli.includes(`case '${verb}':`) || cli.includes(`cmd === '${verb}'`)).toBe(true);
  });
});
