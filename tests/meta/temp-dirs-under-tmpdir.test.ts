/**
 * Every temp directory a test makes is made under os.tmpdir(). The runner
 * points os.tmpdir() into a root of its own and removes that root when the
 * run ends, so whatever a test leaves there goes with it. A directory made
 * under a fixed path (an absolute literal such as /tmp, or a filesystem root)
 * lands outside that root and outlives the run.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const TESTS = join(REPO, 'tests');
const SELF = fileURLToPath(import.meta.url);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.[cm]?[jt]sx?$/.test(path)) out.push(path);
  }
  return out;
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

/** An absolute path literal ('/tmp', "/var/tmp", `/private/...`) or a filesystem root (`path.parse(x).root`). */
const FIXED_BASE = /(['"`])\/[^'"`]*\1|\.root\b/;

describe('temp directories in tests', () => {
  it('are all made under os.tmpdir(), never under a fixed path', () => {
    const offenders: string[] = [];
    for (const file of files(TESTS).filter((path) => path !== SELF)) {
      const source = readFileSync(file, 'utf8');
      for (const { offset, text } of mkdtempArguments(source)) {
        if (!FIXED_BASE.test(text)) continue;
        const line = source.slice(0, offset).split('\n').length;
        offenders.push(`${relative(REPO, file)}:${line}: mkdtemp(${text.replace(/\s+/g, ' ').trim()})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('recognizes a temp directory made under a fixed path', () => {
    const fixed = [
      "fs.mkdtempSync(path.join('/tmp', 'x-'))",
      "mkdtemp(join(process.platform === 'win32' ? os.tmpdir() : \"/tmp\", 'x-'))",
      "fs.mkdtempSync(path.join(path.parse(base).root, 'tmp', 'x-'))",
      'mkdtempSync(`/var/tmp/x-`)',
    ];
    const contained = ["fs.mkdtempSync(path.join(os.tmpdir(), 'x-'))", "mkdtempSync(join(tmpdir(), `x-${id}-`))"];
    expect(fixed.map((call) => mkdtempArguments(call).some(({ text }) => FIXED_BASE.test(text)))).toEqual(fixed.map(() => true));
    expect(contained.map((call) => mkdtempArguments(call).some(({ text }) => FIXED_BASE.test(text)))).toEqual(contained.map(() => false));
  });
});
