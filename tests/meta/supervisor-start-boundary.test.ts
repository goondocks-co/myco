import fs from 'node:fs';
import { expect, it } from 'bun:test';
import path from 'node:path';
import os from 'node:os';
import { createSupervisorStartScanner } from '../helpers/supervisor-starts.ts';
import { closureOf, filesUnder, REPO_ROOT, pathToEntry, withoutShebang, type Closure } from '../helpers/import-closure.ts';
import { walk, walkMemberRuntime } from '../helpers/2-0-closure.ts';
import { isLegacy } from '../helpers/legacy-boundary.ts';

const SRC = path.join(REPO_ROOT, 'packages/myco/src');
const MYCO = 'packages/myco/src/';
const short = (key: string): string => key.startsWith(MYCO) ? key.slice(MYCO.length) : key;
const supervisorStarts = createSupervisorStartScanner(Object.values(walk(undefined, () => false)));

it.each([
  ['launchctl start', 'member/legacy-units.ts', "execFileSync('launchctl', ['start', 'com.myco.daemon']);"],
  ['systemctl now before enable', 'member/legacy-units.ts', "execFileSync('systemctl', ['--user', '--now', 'enable', 'myco.service']);"],
  ['PowerShell scheduled task', 'member/legacy-units.ts', "execFileSync('powershell.exe', ['-Command', 'Start-ScheduledTask -TaskName Myco']);"],
  ['concrete spawn', 'member/legacy-service/launchd.ts', "(new RealLaunchctlRunner() as any).spawn(['kickstart', '-k', label]);"],
  ['conditional verb', 'member/legacy-service/launchd.ts', "const verb = cond ? 'kickstart' : 'print'; this.runner.run([verb, label]);"],
  ['let verb', 'member/legacy-units.ts', "let verb = 'kickstart'; execFileSync('launchctl', [verb, label]);"],
  ['joined shell command', 'member/legacy-units.ts', "execSync(['launchctl', 'kickstart', '-k', label].join(' '));"],
  ['wrapper function', 'member/legacy-units.ts', "const kick = (verb: string) => execFileSync('launchctl', [verb, label]); kick('kickstart');"],
  ['PowerShell queryState join', 'member/legacy-service/windows.ts', "      'Start-ScheduledTask -TaskPath \\\\ -TaskName Myco',"],
] as const)('rejects review mutation: %s', (_name, module, injected) => {
  const mutate = (file: string, text: string): string => {
  if (!file.endsWith('/' + module)) return text;
  if (module.endsWith('windows.ts')) return text.replace('    const command = [', '    const command = [\n' + injected);
  return module.endsWith('launchd.ts')
    ? text.replace('const plistPath = this.plistPath(label);', injected + '\nconst plistPath = this.plistPath(label);')
    : text + '\n' + injected;
  };
  expect(supervisorStarts(walk(mutate, () => false).myco, mutate).length).toBeGreaterThan(0);
}, 120_000);

it.each([
  "let verb = 'print'; verb = 'kickstart'; execFileSync('launchctl', [verb, label]); verb = 'print';",
  "let verb = 'kickstart'; { let verb = 'print'; } execFileSync('launchctl', [verb, label]);",
  "const kick = (verb: string) => execFileSync('launchctl', [verb, label]); const forward = (verb: string) => kick(verb); forward('kickstart');",
])('follows every assignment by symbol, including wrapper parameters: %s', injected => {
  const mutate = (file: string, text: string): string => file.endsWith('/member/legacy-units.ts') ? text + '\n' + injected : text;
  expect(supervisorStarts(walk(mutate, () => false).myco, mutate).some(hit => hit.endsWith('supervisor exec')), injected).toBe(true);
}, 120_000);

it('resolves a renamed PowerShell host from its initializer', () => {
  const mutate = (file: string, text: string): string => file.endsWith('/member/legacy-service/windows.ts')
    ? text.replaceAll('WINDOWS_TASK_HOST', 'RENAMED_TASK_HOST')
      .replace('    const command = [', "    const command = [\n      'Start-ScheduledTask -TaskName Myco',") : text;
  expect(supervisorStarts(walk(mutate, () => false).myco, mutate).some(hit => hit.endsWith('supervisor exec'))).toBe(true);
});

it.each(['outside', 'inside', 'altered'])('rejects starts %s the owned native service reload command', location => {
  const mutate = (file: string, text: string): string => file.endsWith('/server/service.ts')
    ? location === 'altered'
      ? text.replace("  '  launchctl load -w \"$unit\"',", "  '  launchctl load -w \"$unit\"/../evil.plist',")
      : location === 'inside'
      ? text.replace("  '  launchctl load -w \"$unit\"',", "  'launchctl kickstart com.myco.daemon',\n  '  launchctl load -w \"$unit\"',")
      : text.replace('export function reloadServiceDetached(', "execFileSync('launchctl', ['kickstart', '-k', 'com.myco.daemon']);\nexport function reloadServiceDetached(") : text;
  expect(supervisorStarts(walk(mutate, () => false).myco, mutate).some(hit => hit.endsWith('supervisor exec'))).toBe(true);
});

it('admits read-only joined commands and wrappers without mixing shadowed bindings', () => {
  const mutate = (file: string, text: string): string => file.endsWith('/member/legacy-units.ts') ? text + `
    let verb = 'print'; { let verb = 'kickstart'; }
    execFileSync('launchctl', [verb, label]);
    execSync(['launchctl', 'kickstart'].join(''));
    const query = (verb: string) => execFileSync('launchctl', [verb, label]); query('print');
  ` : text;
  expect(supervisorStarts(walk(mutate, () => false).myco, mutate)).toEqual([]);
});

it('maps a protected PowerShell runner method to its platform executable', () => {
  const mutate = (file: string, text: string): string => file.endsWith('/member/legacy-service/windows.ts')
    ? text.replace('const escapedLabel = label.replace', "await this.runPowerShell(['-Command', 'Enable-ScheduledTask -TaskName Myco']);\nconst escapedLabel = label.replace") : text;
  expect(supervisorStarts(walk(mutate, () => false).myco, mutate).some(hit => hit.endsWith('supervisor exec'))).toBe(true);
}, 120_000);

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

it.each([
  'manager.start(label);', "manager['start'](label);", "manager['sta' + 'rt'](label);",
  "const verb = 'start'; manager[verb](label);", 'const { start: launch } = manager; launch(label);',
  'client.ensureRunning();', 'manager.install(spec);', 'manager.bootstrap(label);',
])('rejects direct, computed and bound starts anywhere cutover reaches: %s', call => {
  const mutate = (file: string, text: string): string => file.endsWith('/member/legacy-units.ts') ? text + '\n' + call : text;
  expect(supervisorStarts(walk(mutate, () => false).myco, mutate).length, call).toBeGreaterThan(0);
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


it.each([
  "execFileSync('launchctl', ['kickstart', '-k', label]);",
  "execFileSync('launchctl', ['submit', '-l', label]);",
  "execFileSync('launchctl', ['bootstrap', 'gui/501', file]);",
  "execFileSync('launchctl', ['load', '-w', file]);",
  "execFileSync('launchctl', ['enable', label]);",
  "execFileSync('systemctl', ['--user', 'enable', label, '--now']);",
  "execFileSync('powershell.exe', ['-Command', 'Enable-ScheduledTask -TaskName Myco']);",
  "execFileSync('pwsh', ['-Command', 'Register-ScheduledTask -TaskName Myco']);",
  "execFileSync('systemctl', ['--user', 'reenable', label]);",
  "execFileSync('schtasks', ['/create', '/tn', label]);",
  "execFileSync('schtasks', ['/change', '/tn', label, '/enable']);",
  "execFileSync('systemctl', ['--user', 'start', label]);",
  "execFileSync('schtasks', ['/Run', '/TN', label]);",
  "execSync('launchctl kickstart ' + label);",
  "const argv = ['kickstart', '-k']; execFileSync('launchctl', [...argv, label]);",
])('rejects raw platform starts including const-spread arguments: %s', call => {
  const mutate = (file: string, text: string): string => file.endsWith('/member/legacy-units.ts') ? text + '\n' + call : text;
  expect(supervisorStarts(walk(mutate, () => false).myco, mutate).some(found => found.endsWith('supervisor exec')), call).toBe(true);
}, 120_000);

it.each([
  ['private async isLoaded(label: string): Promise<boolean> {', 'await this.start(label);'],
  ["return spawnCombinedOutput('launchctl', args);", "execFileSync('launchctl', ['kickstart', '-k', 'unit']);"],
  ['private async isLoaded(label: string): Promise<boolean> {', "await this.runner.run(['kickstart', '-k', label]);"],
])('follows cutover through concrete methods and interface implementations: %s / %s', (needle, injected) => {
  const mutate = (file: string, text: string): string => file.endsWith('/member/legacy-service/launchd.ts')
    ? text.replace(needle, needle.startsWith('return ') ? injected + needle : needle + injected) : text;
  expect(supervisorStarts(walk(mutate, () => false).myco, mutate).length, injected).toBeGreaterThan(0);
}, 120_000);

it.each([
  "const runner: LaunchctlRunner = { async run(args: string[]) { return spawnCombinedOutput('launchctl', ['kickstart', '-k', 'unit']); } }; return runner.run(args);",
  "const Runner = class implements LaunchctlRunner { async run(args: string[]) { return spawnCombinedOutput('launchctl', ['kickstart', '-k', 'unit']); } }; return new Runner().run(args);",
])('follows object and class-expression runner implementations: %s', implementation => {
  const mutate = (file: string, text: string): string => file.endsWith('/member/legacy-service/launchd.ts')
    ? text.replace("return spawnCombinedOutput('launchctl', args);", implementation) : text;
  expect(supervisorStarts(walk(mutate, () => false).myco, mutate).length, implementation).toBeGreaterThan(0);
}, 120_000);

it('rejects a raw supervisor start in the Deployment closure', () => {
  const mutate = (file: string, text: string): string => file.endsWith('/myco-server/src/index.ts')
    ? text + "\nexecFileSync('launchctl', ['kickstart', '-k', 'unit']);" : text;
  expect(supervisorStarts(walk(mutate, () => false).server, mutate).some(found => found.endsWith('supervisor exec'))).toBe(true);
}, 120_000);

it('rechecks interface callers for a structural implementation outside their import graph', () => {
  const mutate = (file: string, text: string): string => file.endsWith('/runner/loop.ts') ? text + `
    class HiddenRunner {
      async run(args: string[]) {
        execFileSync('launchctl', ['kickstart', '-k', 'unit']);
        return { stdout: '', exitCode: 0 };
      }
    }
  ` : text;
  expect(supervisorStarts(walk(mutate, () => false).myco, mutate).some(hit => hit.includes('runner/loop.ts:') && hit.endsWith('supervisor exec'))).toBe(true);
}, 120_000);

it('rechecks a wrapper reached by a new import in an overlay', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-supervisor-gate-'));
  try {
    const entry = path.join(directory, 'entry.ts');
    const wrapper = path.join(directory, 'wrapper.ts');
    fs.writeFileSync(entry, 'export {};');
    fs.writeFileSync(wrapper, "export const kick = (verb: string) => execFileSync('launchctl', [verb]);");
    const roots = [entry, wrapper];
    const scan = createSupervisorStartScanner([closureOf(roots)]);
    const mutate = (file: string, text: string): string => file === entry
      ? "import { kick } from './wrapper.js'; kick('kickstart');" : text;
    expect(scan(closureOf(roots, { source: mutate }), mutate).some(hit => hit.endsWith('supervisor exec'))).toBe(true);
    expect(scan(closureOf(roots))).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('drops a removed structural implementation without changing the base scan', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-supervisor-gate-'));
  try {
    const caller = path.join(directory, 'caller.ts');
    const implementation = path.join(directory, 'implementation.ts');
    fs.writeFileSync(caller, `
      interface Runner { run(args: string[]): Promise<{ stdout: string; exitCode: number }> }
      declare const runner: Runner;
      runner.run([]);
      export {};
    `);
    fs.writeFileSync(implementation, `
      export class BadRunner {
        async run(args: string[]) {
          execFileSync('launchctl', ['kickstart']);
          return { stdout: '', exitCode: 0 };
        }
      }
    `);
    const roots = [caller, implementation];
    const scan = createSupervisorStartScanner([closureOf(roots)]);
    expect(scan(closureOf(roots)).some(hit => hit.endsWith('supervisor exec'))).toBe(true);
    const mutate = (file: string, text: string): string => file === implementation ? 'export {};' : text;
    expect(scan(closureOf(roots, { source: mutate }), mutate)).toEqual([]);
    expect(scan(closureOf(roots)).some(hit => hit.endsWith('supervisor exec'))).toBe(true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
