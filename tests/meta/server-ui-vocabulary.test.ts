/**
 * Meta gate: the 2.0 dashboard speaks the 2.0 vocabulary.
 *
 * `docs/architecture/myco-2.0.md` §3 replaces Grove, Team and the machine tier
 * with Deployment and Project, and the standing UI rule is that surfaces name
 * outcomes in the user's vocabulary. A word from the retired model in the new
 * package — in copy, a comment, or an identifier — is a 1.4 concept arriving
 * through a carried file, and the place to catch it is the source, not a
 * screenshot.
 *
 * A second list holds the words a reader must never meet on a page: the
 * brief's glossary names agent, Myco, machine, member, spore, plan and access
 * key, and "runtime", "harness", "credential", "lease", "Deployment" and
 * "Observations" do not appear in the UI. Those words are the server's own
 * names for its mechanism, so identifiers, API paths and comments carry them
 * legitimately; only the strings a reader can see are held to it (JSX text and
 * every literal that reads as prose, `tests/helpers/visible-strings.ts`).
 *
 * A shared module named `*-tables.ts` is skipped by rule: it holds only data
 * the dashboard matches what a run ran against (the programs, subcommands and
 * file extensions `command-shape.ts` reads from `command-tables.ts`), and a
 * word in it reaches a page only inside a command the run itself ran, as
 * written, never as copy of the page's own. `DATA_TABLES` names the rule, and a
 * check below keeps such a module free of anything but its tables' data.
 *
 * Static source scan, no build.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MECHANISM_WORDS, RETIRED_VOCABULARY } from '../helpers/reader-vocabulary.ts';
import { visibleStrings } from '../helpers/visible-strings.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI_SRC = path.join(REPO_ROOT, 'packages', 'myco-server', 'ui', 'src');
const SHARED_SRC = path.join(REPO_ROOT, 'packages', 'myco-shared', 'src');

/**
 * A visible string allowed to carry a mechanism word, keyed `file:text`, each
 * with why a reader needs that word there. Empty: every page says what it means
 * in the reader's words. An entry names the exact text, so a new use is never
 * covered by an old one.
 */
const MECHANISM_ALLOWED: Readonly<Record<string, string>> = {
  'features/admin/settings/catalogue.ts:agent.harnesses. … .credential':
    'A setting key assembled for the API, never shown as page copy',
  'myco-shared/member-protocol.ts:ask a Deployment admin for an invitation for your existing member':
    'REJOIN_HINT is the CLI\'s line, printed in a terminal; the dashboard imports only the controls it names',
  'myco-shared/member-protocol.ts:A machine belongs to one member of a Deployment: every home on it signs in as the same machine':
    'MACHINE_IDENTITY_NOTE is the CLI\'s line; the dashboard shows MEMBER_KEEPS_MACHINES instead',
  'myco-shared/repository.ts:Repository URL must be HTTPS, with a repository path and no credentials, query, or fragment.':
    'the refusal of a URL that carries a user name and password, where "credentials" names exactly the part to take out',
};

/** A shared module of data a run's own words are matched against, never page copy: skipped by the scan. */
const DATA_TABLES = /-tables\.ts$/;

/**
 * The shared modules the dashboard imports, and the shared modules they import in turn: their strings reach its pages
 * too, beside strings only a terminal prints. A data-table module (`DATA_TABLES`) is left out by rule.
 */
function sharedModules(): string[] {
  const files = new Set<string>();
  const queue: string[] = [];
  const add = (file: string) => { if (fs.existsSync(file) && !files.has(file)) { files.add(file); queue.push(file); } };
  for (const file of sources(UI_SRC)) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/from '@goondocks\/myco-shared\/([\w.-]+)'/g)) add(path.join(SHARED_SRC, `${m[1]!}.ts`));
  }
  while (queue.length > 0) {
    const file = queue.pop()!;
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/from '\.\/([\w.-]+?)(?:\.js)?'/g)) add(path.join(SHARED_SRC, `${m[1]!}.ts`));
  }
  return [...files].filter((file) => !DATA_TABLES.test(file));
}

/** Every shared data-table module the dashboard reaches, so the rule that skips them is held to what they hold. */
function dataTables(): string[] {
  return fs.readdirSync(SHARED_SRC).filter((name) => DATA_TABLES.test(name)).map((name) => path.join(SHARED_SRC, name));
}

/** Every visible string of the dashboard and of the shared modules it imports, keyed as the allow-list names them. */
function readerStrings(): Array<{ key: string; where: string; text: string }> {
  const out: Array<{ key: string; where: string; text: string }> = [];
  const files = [
    ...sources(UI_SRC).filter((f) => /\.tsx?$/.test(f) && !f.includes(`${path.sep}specimen${path.sep}`)).map((file) => ({ file, rel: path.relative(UI_SRC, file) })),
    ...sharedModules().map((file) => ({ file, rel: `myco-shared/${path.relative(SHARED_SRC, file)}` })),
  ];
  for (const { file, rel } of files) {
    const name = rel.split(path.sep).join('/');
    for (const { line, text } of visibleStrings(file, fs.readFileSync(file, 'utf8'), { every: true })) out.push({ key: `${name}:${text}`, where: `${name}:${line}`, text });
  }
  return out;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.(tsx?|css|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('server dashboard vocabulary', () => {
  it('scans a non-trivial package (guards against a silently empty scan)', () => {
    expect(sources(UI_SRC).length).toBeGreaterThan(20);
  });

  it('carries no word from the retired Grove, Team, daemon or machine model', () => {
    const hits: string[] = [];
    for (const file of sources(UI_SRC)) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const m = RETIRED_VOCABULARY.exec(line);
        if (m) hits.push(`${path.relative(REPO_ROOT, file)}:${i + 1} "${m[1]}"`);
      });
    }
    expect(hits, 'the 2.0 dashboard names Deployments and Projects; a retired word here is a carried 1.4 concept').toEqual([]);
  });

  it('finds the words a reader sees, and only those', () => {
    const planted = [
      "import { useHarness } from './harness';",
      '// A lease the Deployment holds.',
      "const path = '/api/harness/dispatch';",
      "const reason = 'lease_expired';",
      "if (kind === 'credential') return null;",
      '<p className="t-small text-muted">Each runtime signs in with a credential.</p>',
      '<Input placeholder="Leave blank to keep the current credential" />',
      "const words = { label: 'Runtime' };",
      'const line = `Lease ends in ${span}`;',
      // One lowercase word is words too, wherever it can reach a reader: a title, a helper's answer, a value.
      '<a title="credentials" />',
      "const standing = () => 'lease';",
      "const why = cause.replace(/^x/, 'the runtime went away');",
      '<Input value="Harness" />',
      // The first argument of a write, and every argument of a lookup, are keys and patterns.
      "const kept = params.set('lease', value); const found = text.replace('harness', ''); const held = map.get('credential');",
    ].join('\n');
    const found = visibleStrings('planted.tsx', planted, { every: true }).map((s) => s.text).filter((text) => MECHANISM_WORDS.test(text));
    expect(found).toEqual([
      'Each runtime signs in with a credential.',
      'Leave blank to keep the current credential',
      'Runtime',
      'Lease ends in …',
      'credentials',
      'lease',
      'the runtime went away',
      'Harness',
    ]);
  });

  it('shows no mechanism word to a reader: runtime, harness, credential, lease, Deployment or Observations', () => {
    const strings = readerStrings();
    expect(sharedModules().length, 'the dashboard\'s shared imports were found').toBeGreaterThan(2);
    expect(strings.length, 'the scan read the dashboard\'s words').toBeGreaterThan(1000);
    const hits = strings
      .filter(({ key, text }) => MECHANISM_WORDS.test(text) && MECHANISM_ALLOWED[key] === undefined)
      .map(({ where, text }) => `${where} "${text}"`);
    expect(hits, 'say it in the reader\'s words (tests/meta/server-ui-vocabulary.test.ts lists the glossary)').toEqual([]);
  });

  it('skips a data-table module only where it holds data alone: no import, no function and no sentence built from it', () => {
    const tables = dataTables();
    expect(tables.map((file) => path.basename(file))).toContain('command-tables.ts');
    for (const file of tables) {
      const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect({ file: path.basename(file), imports: /^import /m.test(source), code: /\bfunction\b|=>|`/.test(source) })
        .toEqual({ file: path.basename(file), imports: false, code: false });
    }
  });

  it('allows no entry that no longer matches a visible string', () => {
    const present = new Set(readerStrings().map(({ key }) => key));
    expect(Object.keys(MECHANISM_ALLOWED).filter((key) => !present.has(key))).toEqual([]);
  });
});
