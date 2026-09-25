/**
 * Meta gate: a retained read verb answered for a joined project reaches no
 * local-runtime code.
 *
 * `search`, `vectors`, `session` and `stats` in a joined project are answered
 * by the Deployment (`packages/myco/src/cli/member-reads.ts`). A module in that
 * handler's import closure that opens a vault, a Grove database, the daemon or
 * the 1.4 config loader is a second implementation of the read beside the
 * served tool, and on a machine with no 1.4 install it fails or creates legacy
 * state. The closure is walked, not grepped: a forbidden import two hops deep
 * compiles into the same verb as a direct one (`tests/helpers/import-closure.ts`).
 *
 * The dispatcher half: every read verb the table names is a verb `cli.ts`
 * dispatches, and the branch that routes it to the Deployment sits above the
 * `myco.yaml` gate, so a joined checkout with no vault is never asked for one.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { MEMBER_READ_VERBS } from '@myco/cli/member-read-verbs.js';
import { closureOf, pathToEntry, REPO_ROOT } from '../helpers/import-closure.ts';

const SRC = 'packages/myco/src';

/** The Deployment-answered read handler. */
const ENTRY = `${SRC}/cli/member-reads.ts`;

/** Local-runtime code, by tree or module: the vault, Grove databases, the daemon and its service, Team Host, backups, the 1.4 agent and config. */
const FORBIDDEN: readonly string[] = [
  `${SRC}/daemon/`, `${SRC}/grove/`, `${SRC}/vault/`, `${SRC}/db/`, `${SRC}/host/`, `${SRC}/team/`, `${SRC}/team-host/`, `${SRC}/service/`,
  `${SRC}/backup/`, `${SRC}/services/`, `${SRC}/agent/`, `${SRC}/intelligence/`, `${SRC}/config/`, `${SRC}/logs/`,
  `${SRC}/cli/shared.ts`, `${SRC}/cli/tool.ts`, `${SRC}/mcp/stdio-bridge.ts`, `${SRC}/tools/`,
];

/** The one package the handler may import: the MCP client that calls the served tools. */
const ALLOWED_EXTERNALS: readonly string[] = ['@modelcontextprotocol/client'];

/** Every forbidden module an entry reaches, each with the import chain that reaches it. */
function violations(entry: string): string[] {
  const closure = closureOf([path.join(REPO_ROOT, entry)]);
  const reached = [...closure.modules.keys()]
    .filter((key) => FORBIDDEN.some((prefix) => key === prefix || key.startsWith(prefix)))
    .map((key) => pathToEntry(closure, key).join(' → '));
  const externals = [...closure.externals].filter(([name]) => !ALLOWED_EXTERNALS.includes(name)).map(([name, via]) => `${via} → ${name}`);
  const unknowable = [...closure.unknowable].map(([key, n]) => `${key}: ${n} non-literal import(s)`);
  return [...reached, ...externals, ...unknowable];
}

describe('the member read verbs reach no local-runtime code', () => {
  it(`${ENTRY} imports no vault, Grove, database, daemon or 1.4 config module, at any depth`, () => {
    expect(violations(ENTRY)).toEqual([]);
  });

  it('sees a violation where one exists: the 1.4 search handler reaches the local database', () => {
    expect(violations(`${SRC}/cli/search.ts`).some((line) => line.includes(`${SRC}/db/`))).toBe(true);
  });
});

describe('the dispatcher routes the member read verbs above the myco.yaml gate', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, SRC, 'cli.ts'), 'utf8');
  const routed = cli.indexOf('if (isMemberReadVerb(cmd))');
  const gate = cli.indexOf("path.join(vaultDir, 'myco.yaml')");

  it('the Deployment branch precedes the vault gate', () => {
    expect(routed).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(routed).toBeLessThan(gate);
  });

  it('the routed verbs are exactly the §7.1 CLI rows the ledger names as answered by the Deployment', () => {
    const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'architecture', 'myco-2.0.md'), 'utf8');
    const section = doc.slice(doc.indexOf('### 7.1 CLI commands'), doc.indexOf('### 7.2 '));
    const ledger = [...section.matchAll(/^\| `([^`]+)` \|[^\n]*`cli\/member-reads\.ts`[^\n]*$/gm)].map((m) => m[1]).sort();
    expect(ledger.length).toBeGreaterThan(0);
    expect([...MEMBER_READ_VERBS].sort() as string[]).toEqual(ledger);
  });

  it.each([...MEMBER_READ_VERBS])('%s is a verb the dispatcher knows', (verb) => {
    expect(cli.includes(`case '${verb}':`)).toBe(true);
  });
});
