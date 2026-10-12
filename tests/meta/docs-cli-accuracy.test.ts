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

/** Each command `cli.ts` dispatches, with the source of every module its branch loads. */
function commandModules(): Map<string, string> {
  const lines = CLI.split('\n');
  const modules = new Map<string, string>();
  lines.forEach((line, i) => {
    const names = [...line.matchAll(/cmd === '([a-z_][a-z0-9_-]*)'|case '([a-z_][a-z0-9_-]*)':/g)].map((m) => m[1] ?? m[2]);
    if (names.length === 0) return;
    const block = lines.slice(i, i + 12).join('\n');
    const end = block.indexOf('\n  }') === -1 ? block.length : block.indexOf('\n  }');
    const imports = [...block.slice(0, end + 1).matchAll(/import\('\.\/([a-z/-]+)\.js'\)/g)].map((m) => m[1]);
    const source = imports.map((rel) => fs.readFileSync(path.join(SRC, `${rel}.ts`), 'utf8')).join('\n');
    for (const name of names) modules.set(name, `${modules.get(name) ?? ''}\n${source}`);
  });
  return modules;
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

function problemsFor(modules: Map<string, string>, invocation: Invocation): string[] {
  const { file, line, words } = invocation;
  const [command, ...rest] = words;
  const where = `${file}:${line}: myco ${words.join(' ')}`;
  const source = modules.get(command);
  if (source === undefined) return [`${where}: no such command: ${command}`];
  const problems: string[] = [];
  const sub = rest[0];
  if (sub !== undefined && !sub.startsWith('-') && !isValue(sub) && !new RegExp(`['"\`\\s|(]${sub}['"\`\\s|)]`).test(source)) {
    problems.push(`${where}: ${command} has no subcommand ${sub}`);
  }
  for (const flag of rest.filter((w) => /^--[a-z][a-z0-9-]*/.test(w)).map((w) => w.replace(/[=,.;:)].*$/, ''))) {
    if (!source.includes(flag) && !source.includes(`'${flag.slice(2)}'`)) problems.push(`${where}: ${command} has no flag ${flag}`);
  }
  if (command === 'server' && sub === 'create' && !rest.some((word) => word === '--target' || word.startsWith('--target='))) {
    problems.push(`${where}: server create requires an explicit --target in user docs`);
  }
  return problems;
}

describe('the user docs name only what the CLI has', () => {
  const modules = commandModules();

  it('finds the published pages and the commands in them', () => {
    for (const file of USER_DOCS) expect({ file, exists: fs.existsSync(path.join(ROOT, file)) }).toEqual({ file, exists: true });
    const all = USER_DOCS.flatMap((file) => invocations(file, fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(all.length).toBeGreaterThan(10);
  });

  it('every command, subcommand and flag exists', () => {
    const problems = USER_DOCS.flatMap((file) => invocations(file, fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .flatMap((invocation) => problemsFor(modules, invocation)));
    expect(problems, `These docs name unavailable commands or flags:\n\n${problems.join('\n')}`).toEqual([]);
  });

  it('catches a retired command, a made-up subcommand, a made-up flag and an implicit create target', () => {
    const page = '```bash\nmyco frobnicate\nmyco server teleport --target local\nmyco login --nope <link>\nmyco server create\n```\n';
    const checked = invocations('probe.md', page).map((invocation) => problemsFor(modules, invocation));
    expect(checked.map((problems) => problems.length)).toEqual([1, 1, 1, 1]);
    expect(checked[0][0]).toContain('no such command');
    expect(checked[1][0]).toContain('no subcommand');
    expect(checked[2][0]).toContain('no flag');
    expect(checked[3][0]).toContain('explicit --target');
  });

  it('checks homepage commands and preserves internal command names', () => {
    expect(invocations('index.html', '<pre><code>myco setup --join &lt;address&gt;</code></pre>')[0].words)
      .toEqual(['setup', '--join', '<address>']);
    expect(modules.has('__restore-backup')).toBe(true);
  });
});
