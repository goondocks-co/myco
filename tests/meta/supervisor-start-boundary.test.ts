import fs from 'node:fs';
import { expect, it } from 'bun:test';
import path from 'node:path';
import { supervisorStarts } from '../helpers/supervisor-starts.ts';
import { closureOf, filesUnder, REPO_ROOT, pathToEntry, withoutShebang, type Closure } from '../helpers/import-closure.ts';
import { walk, walkMemberRuntime } from '../helpers/2-0-closure.ts';
import { isLegacy } from '../helpers/legacy-boundary.ts';

const SRC = path.join(REPO_ROOT, 'packages/myco/src');
const MYCO = 'packages/myco/src/';
const short = (key: string): string => key.startsWith(MYCO) ? key.slice(MYCO.length) : key;

const forbiddenRuntime = (key: string): boolean => key.startsWith(`${MYCO}daemon/`)
  || key.startsWith(`${MYCO}db/`) || key === `${MYCO}grove/request-context.ts`;

it('no 2.0 module directly imports a daemon, database or Grove request-context module', () => {
  const { myco, server } = walk();
  for (const closure of [myco, server]) {
    expect([...closure.modules.keys()].filter(forbiddenRuntime).map(key => pathToEntry(closure, key))).toEqual([]);
  }
}, 120_000);

/** Forbidden runtime modules anywhere in the full import closure. */
function forbiddenRuntimePaths(closure: Closure): string[][] {
  return [...closure.modules.keys()].filter(forbiddenRuntime).map(key => pathToEntry(closure, key));
}

it('no 2.0 path transitively reaches a daemon, database or Grove request context', () => {
  const { myco, server } = walk(undefined, () => false);
  expect(forbiddenRuntimePaths(myco)).toEqual([]);
  expect(forbiddenRuntimePaths(server)).toEqual([]);
}, 120_000);

it('hooks, member code and MCP have no transitive daemon, database or Grove request-context dependency', () => {
  expect(forbiddenRuntimePaths(walkMemberRuntime())).toEqual([]);
}, 120_000);

function supervisorReach(mutate?: (file: string, text: string) => string): string[][] {
  const { myco, server } = walk(mutate, () => false);
  const supervisor = /^(?:daemon\/|service\/(?:manager|scoped|self-install|launchd|systemd|windows)\.ts$)/;
  return [myco, server].flatMap(closure => [...closure.modules.keys()].filter(key => supervisor.test(short(key))).map(key => pathToEntry(closure, key)));
}

it('the CLI dispatches no 1.4 verb and has no legacy-verb walk exemption', () => {
  const { myco } = walk();
  expect([...myco.edges.get(MYCO + 'cli.ts') ?? []].filter(key => key.startsWith(MYCO + 'cli/') && isLegacy(key))).toEqual([]);
  expect(fs.readFileSync(path.join(REPO_ROOT, 'tests/helpers/2-0-closure.ts'), 'utf8')).not.toContain('isLegacyVerb');
});

it('rejects a restored 1.4 CLI handler', () => {
  expect(() => walk((file, text) => file.endsWith('/src/cli.ts')
    ? `${text}\nimport './cli/doctor.js';` : text)).toThrow('unresolvable relative import');
});

it('no 2.0 path can reach DaemonClient.ensureRunning or a 1.4 supervisor start', () => {
  expect(supervisorReach()).toEqual([]);
  for (const closure of Object.values(walk(undefined, () => false))) expect(supervisorStarts(closure)).toEqual([]);
}, 120_000);

it('rejects direct, computed and bound starts anywhere cutover reaches', () => {
  for (const call of [
    'manager.start(label);', "manager['start'](label);", "manager['sta' + 'rt'](label);",
    "const verb = 'start'; manager[verb](label);", 'const { start: launch } = manager; launch(label);',
    'client.ensureRunning();', 'manager.install(spec);', 'manager.bootstrap(label);',
  ]) {
    const mutate = (file: string, text: string): string => file.endsWith('/member/legacy-units.ts') ? text + '\n' + call : text;
    expect(supervisorStarts(walk(mutate, () => false).myco, mutate).length, call).toBeGreaterThan(0);
  }
}, 120_000);

function startupModules(mutate?: (file: string, text: string) => string): string[] {
  return [...closureOf([path.join(SRC, 'cli.ts')], {
    staticOnly: true,
    source: (file, text) => withoutShebang(file, mutate ? mutate(file, text) : text),
  }).modules.keys()];
}

it('CLI startup loads no db/schema through static imports', () => {
  expect(startupModules()).not.toContain(MYCO + 'db/schema.ts');
});

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


it('rejects raw platform starts including const-spread arguments', () => {
  for (const call of [
    "execFileSync('launchctl', ['kickstart', '-k', label]);",
    "execFileSync('launchctl', ['bootstrap', 'gui/501', file]);",
    "execFileSync('launchctl', ['load', '-w', file]);",
    "execFileSync('launchctl', ['enable', label]);",
    "execFileSync('systemctl', ['--user', 'enable', label, '--now']);",
    "execFileSync('systemctl', ['--user', 'reenable', label]);",
    "execFileSync('schtasks', ['/create', '/tn', label]);",
    "execFileSync('schtasks', ['/change', '/tn', label, '/enable']);",
    "execFileSync('systemctl', ['--user', 'start', label]);",
    "execFileSync('schtasks', ['/Run', '/TN', label]);",
    "execSync('launchctl kickstart ' + label);",
    "const argv = ['kickstart', '-k']; execFileSync('launchctl', [...argv, label]);",
  ]) {
    const mutate = (file: string, text: string): string => file.endsWith('/member/legacy-units.ts') ? text + '\n' + call : text;
    expect(supervisorStarts(walk(mutate, () => false).myco, mutate).some(found => found.endsWith('supervisor exec')), call).toBe(true);
  }
}, 120_000);

it('follows cutover through concrete methods and interface implementations', () => {
  for (const [needle, injected] of [
    ['private async isLoaded(label: string): Promise<boolean> {', 'await this.start(label);'],
    ["return spawnCombinedOutput('launchctl', args);", "execFileSync('launchctl', ['kickstart', '-k', 'unit']);"],
    ['private async isLoaded(label: string): Promise<boolean> {', "await this.runner.run(['kickstart', '-k', label]);"],
  ]) {
    const mutate = (file: string, text: string): string => file.endsWith('/member/legacy-service/launchd.ts')
      ? text.replace(needle, needle.startsWith('return ') ? injected + needle : needle + injected) : text;
    expect(supervisorStarts(walk(mutate, () => false).myco, mutate).length, injected).toBeGreaterThan(0);
  }
}, 120_000);

it('follows object and class-expression runner implementations', () => {
  for (const implementation of [
    "const runner: LaunchctlRunner = { async run(args: string[]) { return spawnCombinedOutput('launchctl', ['kickstart', '-k', 'unit']); } }; return runner.run(args);",
    "const Runner = class implements LaunchctlRunner { async run(args: string[]) { return spawnCombinedOutput('launchctl', ['kickstart', '-k', 'unit']); } }; return new Runner().run(args);",
  ]) {
    const mutate = (file: string, text: string): string => file.endsWith('/member/legacy-service/launchd.ts')
      ? text.replace("return spawnCombinedOutput('launchctl', args);", implementation) : text;
    expect(supervisorStarts(walk(mutate, () => false).myco, mutate).length, implementation).toBeGreaterThan(0);
  }
}, 120_000);

it('rejects a raw supervisor start in the Deployment closure', () => {
  const mutate = (file: string, text: string): string => file.endsWith('/myco-server/src/index.ts')
    ? text + "\nexecFileSync('launchctl', ['kickstart', '-k', 'unit']);" : text;
  expect(supervisorStarts(walk(mutate, () => false).server, mutate).some(found => found.endsWith('supervisor exec'))).toBe(true);
}, 120_000);
