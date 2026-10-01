/**
 * The user docs document only commands, subcommands and flags the CLI has.
 *
 * Every `myco …` invocation in the README and the published guides (code
 * blocks and inline code) is checked against the CLI itself: the command must
 * be one `cli.ts` dispatches, its subcommand must be a word the command's
 * module names, and each `--flag` must appear in that module (its parser or
 * its help, which `tests/cli/help-matches-parser.test.ts` holds to the parser).
 * A doc that names a retired or misspelled command fails here instead of
 * leaving a first-time user with "Unknown command".
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { NAV } from '../../docs/lib/nav.mjs';

const ROOT = path.join(import.meta.dir, '..', '..');
const SRC = path.join(ROOT, 'packages', 'myco', 'src');
const CLI = fs.readFileSync(path.join(SRC, 'cli.ts'), 'utf8');

/** The user-facing pages: the README and every guide the site publishes, architecture pages aside. */
export const USER_DOCS = ['README.md', ...NAV.flatMap((g) => g.items.map((i) => i.slug))
  .filter((slug) => !slug.startsWith('architecture/'))
  .map((slug) => `docs/${slug}.md`)];

/** Each command `cli.ts` dispatches, with the source of every module its branch loads. */
function commandModules(): Map<string, string> {
  const lines = CLI.split('\n');
  const modules = new Map<string, string>();
  lines.forEach((line, i) => {
    const names = [...line.matchAll(/cmd === '([a-z][a-z0-9-]*)'|case '([a-z][a-z0-9-]*)':/g)].map((m) => m[1] ?? m[2]);
    if (names.length === 0) return;
    const block = lines.slice(i, i + 12).join('\n');
    const end = block.indexOf('\n  }') === -1 ? block.length : block.indexOf('\n  }');
    const imports = [...block.slice(0, end + 1).matchAll(/import\('\.\/([a-z/-]+)\.js'\)/g)].map((m) => m[1]);
    const source = imports.map((rel) => { try { return fs.readFileSync(path.join(SRC, `${rel}.ts`), 'utf8'); } catch { return ''; } }).join('\n');
    for (const name of names) modules.set(name, `${modules.get(name) ?? ''}\n${source}`);
  });
  return modules;
}

export interface Invocation { file: string; line: number; words: string[] }

/** Every `myco …` a page tells the user to run: code-block lines and inline code. */
export function invocations(file: string, text: string): Invocation[] {
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

describe('the user docs name only what the CLI has', () => {
  const modules = commandModules();

  it('finds the published pages and the commands in them', () => {
    for (const file of USER_DOCS) expect({ file, exists: fs.existsSync(path.join(ROOT, file)) }).toEqual({ file, exists: true });
    const all = USER_DOCS.flatMap((file) => invocations(file, fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(all.length).toBeGreaterThan(10);
  });

  it('every command, subcommand and flag exists', () => {
    const problems: string[] = [];
    for (const file of USER_DOCS) {
      for (const { line, words } of invocations(file, fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
        const [command, ...rest] = words;
        const where = `${file}:${line}: myco ${words.join(' ')}`;
        const source = modules.get(command);
        if (source === undefined) { problems.push(`${where}\n    no such command: ${command}`); continue; }
        const sub = rest[0];
        if (sub !== undefined && !sub.startsWith('-') && !isValue(sub) && !new RegExp(`['"\`\\s|(]${sub}['"\`\\s|)]`).test(source)) {
          problems.push(`${where}\n    ${command} has no subcommand ${sub}`);
        }
        for (const flag of rest.filter((w) => /^--[a-z][a-z0-9-]*/.test(w)).map((w) => w.replace(/[=,.;:)].*$/, ''))) {
          if (!source.includes(flag) && !source.includes(`'${flag.slice(2)}'`)) problems.push(`${where}\n    ${command} has no flag ${flag}`);
        }
      }
    }
    expect(problems, `These docs name commands or flags the CLI does not have:\n\n${problems.join('\n')}`).toEqual([]);
  });

  it('catches a retired command, a made-up subcommand and a made-up flag', () => {
    const page = '```bash\nmyco frobnicate\nmyco server teleport --target local\nmyco login --nope <link>\n```\n';
    const checked = invocations('probe.md', page).map(({ words }) => {
      const source = modules.get(words[0]);
      if (source === undefined) return 'command';
      if (words[1] && !words[1].startsWith('-') && !new RegExp(`['"\`\\s|(]${words[1]}['"\`\\s|)]`).test(source)) return 'subcommand';
      return words.some((w) => w.startsWith('--') && !source.includes(w)) ? 'flag' : 'ok';
    });
    expect(checked).toEqual(['command', 'subcommand', 'flag']);
  });
});
