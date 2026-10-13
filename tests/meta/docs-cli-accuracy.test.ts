/** Published commands, subcommands and flags match the CLI source vocabulary. */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { NAV } from '../../docs/lib/nav.mjs';

const ROOT = path.join(import.meta.dir, '..', '..');
const SRC = path.join(ROOT, 'packages', 'myco', 'src');
const CLI = fs.readFileSync(path.join(SRC, 'cli.ts'), 'utf8');

/** Front doors and published user guides. */
export const USER_DOCS = ['README.md', 'packages/myco/README.md', 'docs/index.html', 'docs/llms.txt', ...NAV.flatMap((g) => g.items.map((i) => i.slug))
  .filter((slug) => !slug.startsWith('architecture/'))
  .map((slug) => `docs/${slug}.md`)];

interface CommandSurface { flags: Set<string>; subcommands: Map<string, Set<string>> }
const readSource = (relative: string): string => fs.readFileSync(path.join(SRC, relative), 'utf8');
const flagsIn = (text: string): Set<string> => new Set(text.match(/--[a-z][a-z0-9-]*/g) ?? []);

function functionSource(source: string, name: string): string {
  const match = source.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([\\s\\S]*?\\n}`));
  if (!match) throw new Error(`Missing parser: ${name}`);
  return match[0];
}

/** Read help without importing modules that can start the runtime. */
function helpConstant(source: string, name: string): string {
  const match = [...source.matchAll(/(?:export )?const ([A-Z_]+) = `((?:\\.|[^`\\])*)`/g)].find((m) => m[1] === name);
  if (!match) throw new Error(`Missing help constant: ${name}`);
  return match[2];
}

/** The public member vocabulary, with cli.ts used only to locate help-owning modules. */
function commandSurfaces(): Map<string, CommandSurface> {
  const usage = helpConstant(readSource('cli/member-dispatch.ts'), 'MEMBER_USAGE');
  const entries = new Map([...usage.matchAll(/^  ([a-z][a-z0-9-]*)\b([^\n]*)/gm)].map((m) => [m[1], m[2]]));
  const names = new Set([...entries.keys(), 'setup', 'cutover', 'logout']);
  for (const alias of usage.matchAll(/alias: ([a-z-]+)/g)) names.add(alias[1]);
  const surfaces = new Map<string, CommandSurface>();
  for (const command of names) {
    const delegated = CLI.match(new RegExp(`^  ${command}: async.*import\\('\\./([a-z/-]+)\\.js'\\)\\)\\.([A-Z_]+)`, 'm'));
    const dispatched = CLI.match(new RegExp(`case '${command}': return \\(await import\\('\\./([a-z/-]+)\\.js'\\)\\)`));
    const guarded = CLI.match(new RegExp(`if \\(cmd === '${command}'\\)\\s*(?:\\{[^{}]*?|\\s*)return \\(await import\\('\\./([a-z/-]+)\\.js'\\)\\)`));
    const relative = delegated?.[1] ?? dispatched?.[1] ?? guarded?.[1];
    const source = relative ? readSource(`${relative}.ts`) : '';
    const help = command === 'doctor' || !delegated
      ? entries.get(command) ?? ''
      : helpConstant(source, delegated[2]);
    const subcommands = new Map<string, Set<string>>();
    const nested = ['member', 'server', 'runner'].includes(command);
    if (nested) {
      let current: Set<string> | undefined;
      for (const line of help.split('\n')) {
        const signature = line.match(/^  (?:myco runner )?([a-z][a-z-]*)\b(.*)/);
        if (signature) {
          current = subcommands.get(signature[1]) ?? new Set<string>();
          subcommands.set(signature[1], current);
        } else if (line.trim() && !/^\s/.test(line)) current = undefined;
        if (current) for (const flag of flagsIn(line)) current.add(flag);
      }
      if (command === 'member') {
        const publicOps = new Set((entries.get('member') ?? '').replace(/^\s*<op>\s*/, '').split(/\s*\|\s*/));
        for (const op of subcommands.keys()) if (!publicOps.has(op)) subcommands.delete(op);
        // Provision's parser also accepts refresh, which its help omits.
        for (const flag of flagsIn(functionSource(source, 'runProvision'))) subcommands.get('provision')!.add(flag);
      }
      if (command === 'server') {
        for (const [op, flags] of subcommands) {
          const branches = [...source.matchAll(new RegExp(`^([ \\t]*)if \\(command === '${op}'[^\\n]*\\{[\\s\\S]*?^\\1}`, 'gm'))];
          if (branches.some((branch) => branch[0].includes('cloudflareOptions()'))) flags.add('--account-id');
        }
      }
    } else if (command === 'config') subcommands.set('get', new Set());
    else if (command === 'tool') {
      const credential = readSource('member/constants.ts').match(/export const CREDENTIAL_FLAG = '([^']+)'/);
      if (!credential) throw new Error('Missing credential flag');
      const common = flagsIn(functionSource(source, 'run').split("if (subcommand === 'list')")[0]);
      common.add(credential[1]);
      subcommands.set('list', common);
      subcommands.set('call', new Set([...common, ...flagsIn(functionSource(source, 'parseCallArgs'))]));
    } else if (command === 'worker') {
      const runner = surfaces.get('runner');
      if (!runner) throw new Error('Runner help must precede worker help');
      for (const op of ['install', 'status', 'doctor', 'uninstall']) subcommands.set(op, runner.subcommands.get(op)!);
    }
    const options = help.split('\n').filter((line) => /^  |^Usage:/.test(line)).join('\n');
    surfaces.set(command, { flags: nested || subcommands.size ? new Set() : flagsIn(options || help), subcommands });
  }
  return surfaces;
}

export interface Invocation { file: string; line: number; words: string[] }

/** Every `myco …` a page tells the user to run: code-block lines and inline code. */
export function invocations(file: string, text: string): Invocation[] {
  if (file.endsWith('.html')) text = text.replace(/<code>([\s\S]*?)<\/code>/g, (_, code: string) => `\`${code.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')}\``);
  const found: Invocation[] = [];
  let inBlock = false;
  text.split('\n').forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { inBlock = !inBlock; return; }
    const candidates = inBlock
      ? [raw.trim().replace(/^\$\s+/, '').replace(/\s+#.*$/, '')]
      : [...raw.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    for (const candidate of candidates) {
      if (candidate.startsWith('myco ')) found.push({ file, line: i + 1, words: candidate.split(/\s+/).slice(1) });
    }
  });
  return found;
}

/** A word that is a value a person types in, not a subcommand: a placeholder, path, URL or quoted string. */
const isValue = (word: string): boolean => /^[<[{"'`$~./…]|:\/\/|^https?:|=/.test(word) || /^[A-Z]/.test(word) || /\d/.test(word);

/** Only the explicitly headed 1.4 reference section uses the retired vocabulary. */
function currentInvocations(file: string, text: string): Invocation[] {
  if (file === 'docs/upgrade.md') {
    text = text.replace(/(^## Myco 1\.4 updates\n)[\s\S]*?(?=^<a id="upgrading-from-myco-14"><\/a>)/m,
      (history: string) => history.replace(/[^\n]/g, ' '));
  }
  return invocations(file, text);
}

function problemsFor(surfaces: Map<string, CommandSurface>, invocation: Invocation): string[] {
  const { file, line, words } = invocation;
  const [command, ...rest] = words;
  const where = `${file}:${line}: myco ${words.join(' ')}`;
  const surface = surfaces.get(command);
  if (surface === undefined) return [`${where}: no such 2.0 command: ${command}`];
  const problems: string[] = [];
  const sub = rest[0];
  let flags = surface.flags;
  if (surface.subcommands.size && sub !== undefined && !sub.startsWith('-') && !isValue(sub)) {
    const scoped = surface.subcommands.get(sub);
    if (!scoped) problems.push(`${where}: ${command} has no subcommand ${sub}`);
    else flags = scoped;
  }
  for (const flag of flagsIn(rest.join(' '))) {
    if (!flags.has(flag) && flag !== '--help') problems.push(`${where}: ${command} ${sub ?? ''} has no flag ${flag}`);
  }
  if (command === 'server' && sub === 'create' && !rest.some((word) => word === '--target' || word.startsWith('--target='))) {
    problems.push(`${where}: server create requires an explicit --target in user docs`);
  }
  return problems;
}

describe('the user docs name only what the CLI has', () => {
  const surfaces = commandSurfaces();

  it('finds the published pages and the commands in them', () => {
    for (const file of USER_DOCS) expect({ file, exists: fs.existsSync(path.join(ROOT, file)) }).toEqual({ file, exists: true });
    const all = USER_DOCS.flatMap((file) => currentInvocations(file, fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(all.length).toBeGreaterThan(10);
  });

  it('every command, subcommand and flag exists', () => {
    const problems = USER_DOCS.flatMap((file) => currentInvocations(file, fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .flatMap((invocation) => problemsFor(surfaces, invocation)));
    expect(problems, `These docs name unavailable commands or flags:\n\n${problems.join('\n')}`).toEqual([]);
  });

  it('catches a retired command, a made-up subcommand, a made-up flag and an implicit create target', () => {
    const page = '```bash\nmyco frobnicate\nmyco server teleport --target local\nmyco login --nope <link>\nmyco server create\n```\n';
    const checked = invocations('probe.md', page).map((invocation) => problemsFor(surfaces, invocation));
    for (const problems of checked) expect(problems.length).toBeGreaterThan(0);
    expect(checked[0][0]).toContain('no such 2.0 command');
    expect(checked[1][0]).toContain('no subcommand');
    expect(checked[2][0]).toContain('no flag');
    expect(checked[3][0]).toContain('explicit --target');
  });

  it('checks homepage commands and refuses the ledger DROP verbs', () => {
    expect(invocations('index.html', '<pre><code>myco setup --join &lt;address&gt;</code></pre>')[0].words)
      .toEqual(['setup', '--join', '<address>']);
    const ledger = fs.readFileSync(path.join(ROOT, 'docs/architecture/myco-2.0.md'), 'utf8');
    const cliLedger = ledger.split('### 7.1 ')[1].split('### 7.2 ')[0];
    const dropped = [...cliLedger.matchAll(/^\| `([a-z_-]+)` \| DROP \|/gm)].map((match) => match[1]);
    expect(dropped.length).toBeGreaterThan(5);
    for (const command of dropped) expect(surfaces.has(command)).toBe(false);
    expect(surfaces.has('__restore-backup')).toBe(false);
  });
  it.each([
    'restart', 'host', 'init', 'daemon start', 'grove list', 'doctor --fix',
    'member join <address> --token-env X --purge',
    'runner status --replace', 'server status --url <address>',
  ])('rejects unavailable 2.0 usage: myco %s', (command) => {
    expect(problemsFor(surfaces, invocations('probe.md', `\`myco ${command}\``)[0]).length).toBeGreaterThan(0);
  });

  it.each(['member leave --purge', 'member join --project <id>', 'member join --new [name]', 'runner register <address> --replace'])('accepts flags on their own subcommand: myco %s', (command) => {
    expect(problemsFor(surfaces, invocations('probe.md', `\`myco ${command}\``)[0])).toEqual([]);
  });

  it('checks current commands on both sides of the historical 1.4 section', () => {
    const page = '`myco restart`\n## Myco 1.4 updates\n`myco host`\n<a id="upgrading-from-myco-14"></a>\n`myco init`';
    expect(currentInvocations('docs/upgrade.md', page).map((i) => i.words[0])).toEqual(['restart', 'init']);
    expect(currentInvocations('docs/quickstart.md', page).length).toBe(3);
  });
});
