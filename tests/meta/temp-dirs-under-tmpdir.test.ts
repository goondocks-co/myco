/**
 * Tests keep their temp files under os.tmpdir(). The runner points os.tmpdir()
 * into a root of its own and removes that root when the run ends, so whatever
 * a test leaves there goes with it. A path under a fixed temp directory (/tmp,
 * /private/tmp, /var/tmp) or a filesystem root lands outside that root and
 * outlives the run, so no test names one: not as a temp base, not as a fake
 * path a later change could start writing to, not held in a variable.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const TESTS = join(REPO, 'tests');
const SELF = fileURLToPath(import.meta.url);

/**
 * The fixed temp paths a test may name, by `file: literal`, each with why. A
 * test asserting where production puts something outside the temp directory
 * names that path; nothing else does.
 */
const NAMED_FIXED_PATHS: ReadonlyMap<string, string> = new Map([
  ['tests/config/secrets.test.ts: `/var/tmp/myco-locks-${process.getuid!()}`', 'asserts the production per-user lock root, which is fixed outside every temp directory'],
  ["tests/setup/sandbox-preload.ts: '/var/tmp'", 'fences the native per-user lock root against test writes'],
]);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.[cm]?[jt]sx?$/.test(path)) out.push(path);
  }
  return out;
}

/** A string literal that is a fixed temp directory or a path under one. */
const FIXED_TEMP_LITERAL = /(['"`])\/(?:private\/tmp|var\/tmp|tmp)(?:\/[^'"`\n]*)?\1/g;

function fixedTempLiterals(source: string): string[] {
  return [...source.matchAll(FIXED_TEMP_LITERAL)].map((match) => match[0]);
}

/** The argument text of each `mkdtemp`/`mkdtempSync` call in `source`, up to its closing parenthesis. */
function mkdtempArguments(source: string): Array<{ offset: number; text: string }> {
  const calls: Array<{ offset: number; text: string }> = [];
  for (const match of source.matchAll(/\bmkdtemp(?:Sync)?\s*\(/g)) {
    const start = match.index! + match[0].length;
    let depth = 1;
    let end = start;
    while (end < source.length && depth > 0) {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')') depth -= 1;
      end += 1;
    }
    calls.push({ offset: match.index!, text: source.slice(start, end - 1) });
  }
  return calls;
}

/** A temp base built on a filesystem root (`path.parse(x).root`) or an absolute literal. */
const ROOTED_BASE = /(['"`])\/[^'"`]*\1|\.root\b/;

function testSources(): Array<{ name: string; source: string }> {
  return files(TESTS).filter((path) => path !== SELF).map((path) => ({ name: relative(REPO, path), source: readFileSync(path, 'utf8') }));
}

describe('temp paths in tests', () => {
  it('name no fixed temp directory, apart from the named production paths', () => {
    const offenders: string[] = [];
    for (const { name, source } of testSources()) {
      for (const literal of fixedTempLiterals(source)) {
        if (!NAMED_FIXED_PATHS.has(`${name}: ${literal}`)) offenders.push(`${name}: ${literal}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('make every temp directory under os.tmpdir(), never under a filesystem root or an absolute path', () => {
    const offenders: string[] = [];
    for (const { name, source } of testSources()) {
      for (const { offset, text } of mkdtempArguments(source)) {
        if (!ROOTED_BASE.test(text)) continue;
        offenders.push(`${name}:${source.slice(0, offset).split('\n').length}: mkdtemp(${text.replace(/\s+/g, ' ').trim()})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('holds the named paths to what actually stands in the tests', () => {
    const named = new Set(testSources().flatMap(({ name, source }) => fixedTempLiterals(source).map((literal) => `${name}: ${literal}`)));
    for (const exempt of NAMED_FIXED_PATHS.keys()) expect({ exempt, present: named.has(exempt) }).toEqual({ exempt, present: true });
  });

  it('recognizes fixed temp paths however a test spells them', () => {
    const fixed = [
      "const BASE = '/tmp';",
      'mkdirSync("/private/tmp/x", { recursive: true });',
      'const lock = `/var/tmp/locks-${uid}`;',
      "spawn('x', [], { cwd: '/tmp/work' });",
    ];
    const other = ["const p = '/tmpfoo';", "path.join(os.tmpdir(), 'tmp')", "'/fixture/tmp/x'", "'/var/tmpx'"];
    expect(fixed.map((line) => fixedTempLiterals(line).length > 0)).toEqual(fixed.map(() => true));
    expect(other.map((line) => fixedTempLiterals(line).length > 0)).toEqual(other.map(() => false));

    const rooted = ["fs.mkdtempSync(path.join(path.parse(base).root, 'tmp', 'x-'))", "mkdtempSync(join('/srv', 'x-'))"];
    const contained = ["fs.mkdtempSync(path.join(os.tmpdir(), 'x-'))", 'mkdtempSync(join(tmpdir(), `x-${id}-`))'];
    expect(rooted.map((call) => mkdtempArguments(call).some(({ text }) => ROOTED_BASE.test(text)))).toEqual(rooted.map(() => true));
    expect(contained.map((call) => mkdtempArguments(call).some(({ text }) => ROOTED_BASE.test(text)))).toEqual(contained.map(() => false));
  });
});
