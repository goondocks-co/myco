/**
 * Anti-drift test binding `docs/okf.md`'s documented `myco okf …` command
 * lines to the real, pure `parseOkfCommand` parser. If a doc example drifts
 * out of sync with the CLI's actual flag/argument grammar, this test fails
 * with the offending command line and the parser's own error message.
 *
 * Extraction scans fenced (```) code blocks only — inline backticks and
 * non-okf commands are ignored — and looks for lines that, after trimming,
 * begin with `myco okf`. Each match is split into argv with the leading
 * `myco okf` tokens dropped, matching `parseOkfCommand`'s actual argv
 * contract: `run(args, vaultDir)` in `packages/myco/src/cli/okf.ts` passes
 * `parseOkfCommand` the tokens AFTER `myco okf` (confirmed from `run()`'s own
 * call site and mirrored by the existing `tests/smoke/okf-phase1a.test.ts`,
 * which calls `runOkf(['maintain'], vaultDir)` with no leading `okf` token).
 *
 * A minimum-count assertion (>= 6) guards against a scanning regression that
 * would otherwise let this test pass vacuously on zero extracted commands.
 *
 * Also asserts the committed fixture at tests/okf/fixtures/okf-example-bundle/
 * validates cleanly at BOTH `conformance` and `myco_strict` levels — no
 * fallback was needed; the fixture was hand-authored to match the exact
 * frontmatter shapes emitted by okf/serialize.ts and okf/validate.ts (root
 * index.md carries okf_version-led frontmatter, concepts/index.md carries
 * none, and both concept files satisfy every myco_strict rule).
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseOkfCommand } from '@myco/cli/okf.js';
import { validateBundleTree } from '@myco/okf/validate.js';

const DOCS_PATH = path.resolve(__dirname, '../../docs/okf.md');
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/okf-example-bundle');

/** Naive shell-ish tokenizer: splits on whitespace, honoring "..." quoting. */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    tokens.push(match[1] !== undefined ? match[1] : match[2]);
  }
  return tokens;
}

/** Extract every `myco okf …` command line from fenced code blocks in a markdown doc. */
function extractOkfCommands(markdown: string): string[] {
  const lines = markdown.split('\n');
  const commands: string[] = [];
  let inFence = false;
  for (const rawLine of lines) {
    if (/^```/.test(rawLine.trim())) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('myco okf')) commands.push(trimmed);
  }
  return commands;
}

describe('docs/okf.md examples stay in sync with parseOkfCommand', () => {
  const markdown = fs.readFileSync(DOCS_PATH, 'utf8');
  const commands = extractOkfCommands(markdown);

  it('extracts a non-trivial number of myco okf command lines (guards against a vacuous scan)', () => {
    expect(commands.length).toBeGreaterThanOrEqual(6);
  });

  it('every documented `myco okf` command line parses successfully', () => {
    for (const command of commands) {
      const tokens = tokenize(command);
      // Drop the leading `myco okf` tokens — parseOkfCommand's argv contract
      // starts at the subcommand (e.g. 'status', 'maintain', 'concept').
      expect(tokens[0]).toBe('myco');
      expect(tokens[1]).toBe('okf');
      const argv = tokens.slice(2);
      const result = parseOkfCommand(argv);
      expect(
        result.ok,
        `command ${JSON.stringify(command)} failed to parse: ${result.ok ? '' : result.error}`,
      ).toBe(true);
    }
  });
});

describe('tests/okf/fixtures/okf-example-bundle validates', () => {
  it('passes conformance validation cleanly', () => {
    const report = validateBundleTree(FIXTURE_DIR, 'conformance');
    expect(report.ok, JSON.stringify(report.issues)).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('passes myco_strict validation cleanly', () => {
    const report = validateBundleTree(FIXTURE_DIR, 'myco_strict');
    expect(report.ok, JSON.stringify(report.issues)).toBe(true);
    expect(report.issues).toEqual([]);
  });
});
