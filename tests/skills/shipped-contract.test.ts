/**
 * The contract every skill that ships with Myco is held to.
 *
 * These files are loaded into an agent's listing at the start of every session,
 * so their cost is paid whether or not they are used, and a client truncates or
 * drops entries over its budget with no error. The caps are therefore gates,
 * not guidance.
 *
 * Two of the cases hold a skill to code rather than to a number: the setup
 * skill names commands and refusals, and a skill that tells an agent to run a
 * verb that no longer exists is worse than no skill at all. Those read the
 * verb list and the refusal text out of the sources, never a list restated
 * here.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  SHIPPED_SKILLS_DIR,
  SHIPPED_SKILL_LISTING_MAX_BYTES,
  SHIPPED_SKILL_LISTING_TOTAL_MAX_BYTES,
  SHIPPED_SKILL_MAX_LINES,
} from '@myco/skills/names.js';
import { scanForContamination } from '@myco/agent/tools/skill-contamination.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_ROOT = path.join(REPO_ROOT, 'packages/myco', SHIPPED_SKILLS_DIR);

/** The same "a directory is a skill iff it holds a SKILL.md" predicate the codegen and the installer use. */
function shippedSkillNames(): string[] {
  return fs
    .readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(SKILLS_ROOT, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
}

interface Frontmatter {
  readonly keys: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
}

/** Frontmatter as key → value, folded block scalars rejoined onto one line. */
function frontmatter(markdown: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (match === null) return { keys: new Set(), values: new Map() };
  const lines = match[1].split('\n');
  const keys = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^([A-Za-z_-]+):(.*)$/.exec(lines[i]);
    if (head === null) continue;
    const [, key, rest] = head;
    keys.add(key);
    const inline = rest.trim();
    if (inline !== '>-' && inline !== '>' && inline !== '|' && inline !== '|-') {
      values.set(key, inline);
      continue;
    }
    const body: string[] = [];
    for (const line of lines.slice(i + 1)) {
      if (!/^\s/.test(line) || line.trim() === '') break;
      body.push(line.trim());
    }
    values.set(key, body.join(' '));
    i += body.length;
  }
  return { keys, values };
}

const bytes = (s: string): number => new TextEncoder().encode(s).length;
const read = (name: string): string => fs.readFileSync(path.join(SKILLS_ROOT, name, 'SKILL.md'), 'utf-8');

const NAMES = shippedSkillNames();

describe('the skills that ship with Myco', () => {
  it('enumerates a non-empty tree', () => {
    // Every case below is per-skill, so an empty enumeration would pass them all.
    expect(NAMES.length).toBeGreaterThan(0);
  });

  for (const name of NAMES) {
    describe(name, () => {
      const markdown = read(name);
      const fm = frontmatter(markdown);

      it('declares name, description and when_to_use, and the name is its directory', () => {
        expect([...fm.keys].filter((k) => ['name', 'description', 'when_to_use'].includes(k)).sort()).toEqual([
          'description',
          'name',
          'when_to_use',
        ]);
        expect(fm.values.get('name')).toBe(name);
      });

      it('fits the listing budget a client gives one entry', () => {
        const listing = bytes(fm.values.get('description') ?? '') + bytes(fm.values.get('when_to_use') ?? '');
        expect(listing).toBeLessThanOrEqual(SHIPPED_SKILL_LISTING_MAX_BYTES);
        expect(listing).toBeGreaterThan(0);
      });

      it('stays within the line cap', () => {
        expect(markdown.split('\n').length).toBeLessThanOrEqual(SHIPPED_SKILL_MAX_LINES);
      });

      it('references only files that exist inside the skill', () => {
        const dir = path.join(SKILLS_ROOT, name);
        const referenced = [...markdown.matchAll(/`((?:references|scripts)\/[A-Za-z0-9._/-]+)`/g)].map((m) => m[1]);
        expect(referenced.filter((rel) => !fs.existsSync(path.join(dir, rel)))).toEqual([]);
      });

      it('carries no hard contamination', () => {
        expect(scanForContamination(markdown).hard.map((s) => s.kind)).toEqual([]);
      });
    });
  }

  it('fits the listing budget for every entry added together', () => {
    const total = NAMES.reduce((sum, name) => {
      const fm = frontmatter(read(name));
      return sum + bytes(fm.values.get('description') ?? '') + bytes(fm.values.get('when_to_use') ?? '');
    }, 0);
    // The per-skill cap bounds one entry and says nothing about the sum. A client
    // over its own listing budget drops entries with a debug-log warning rather
    // than an error, so the skill that pushes the total over is the one nobody
    // sees go missing.
    expect(total).toBeLessThanOrEqual(SHIPPED_SKILL_LISTING_TOTAL_MAX_BYTES);
  });
});

describe('the setup skill against the code it drives', () => {
  const SETUP = 'myco-setup';
  const markdown = read(SETUP);

  it('names only commands the CLI registers', () => {
    const cli = fs.readFileSync(path.join(REPO_ROOT, 'packages/myco/src/cli.ts'), 'utf-8');
    // The verbs the dispatcher answers, read from the dispatcher itself.
    const registered = new Set([
      ...[...cli.matchAll(/cmd === '([a-z-]+)'/g)].map((m) => m[1]),
      ...[...cli.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]),
    ]);
    expect(registered.size).toBeGreaterThan(0);
    // Commands appear two ways: a line inside a fenced block, and an inline
    // code span. Prose mentioning the binary by name is not an invocation, so
    // neither pattern reads bare text.
    const fenced = [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
    const named = [
      ...[...fenced.matchAll(/^myco ([a-z][a-z-]*)/gm)].map((m) => m[1]),
      ...[...markdown.matchAll(/`myco ([a-z][a-z-]*)`/g)].map((m) => m[1]),
    ];
    expect(named.length).toBeGreaterThan(0);
    expect([...new Set(named)].filter((verb) => !registered.has(verb))).toEqual([]);
  });

  it('names refusals that still exist at their source', () => {
    const installer = fs.readFileSync(path.join(REPO_ROOT, 'packages/myco/src/symbionts/installer.ts'), 'utf-8');
    const ps1 = fs.readFileSync(path.join(REPO_ROOT, 'docs/install.ps1'), 'utf-8');
    // The skill tells a user what to do about each of these. If the refusal goes
    // away, the advice becomes a description of a problem they cannot have.
    expect(installer).toContain('contains whitespace');
    expect(ps1).toContain('ARM64');
    expect(markdown).toContain('whitespace');
    expect(markdown.toLowerCase()).toContain('arm');
  });
});
