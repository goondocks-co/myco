import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { infrastructureFaultSignature, infrastructureRetrySummary } from '../../scripts/infrastructure-faults.mjs';
import {
  assertRunnerBudget, checkTestBudget, countLines, formatRatio, lineCountsAt, plannedNodeRunnerMs,
  PR_NODE_RUNNER_BUDGET_MS, ratioRefusal, ratioRoseAboveOne,
} from '../../scripts/check-test-budget.mjs';

const SAMPLES: [string, string | null][] = [
  [`AssertionError [ERR_ASSERTION]: false == true\n    at Socket.connect (node_modules/miniflare/dist/src/workers/shared/proxy.worker.js:12:5)\n`, 'miniflare proxy assertion'],
  [`AssertionError: devalue internal assertion\n    at uneval (node_modules/devalue/uneval.js:4:1)\n`, 'devalue internal assertion'],
  ['TypeError: Unable to connect\n    at TCPConnectWrap.afterConnect (node:net:1:1)\n', 'TypeError: Unable to connect'],
  ['Error: Network connection lost\n    at D1PreparedStatement.run (workerd)\n', 'D1 Network connection lost'],
  ['(fail) saves a row\nerror: expect(received).toBe(expected)\nExpected: 1\nReceived: 2\nTypeError: Unable to connect\n', null],
  ['AssertionError: expected true to be false\n    at /tmp/case.test.ts:4:1\n', null],
  ['error: the port is closed\n', null],
  ['', null],
];

test('classifies an infrastructure fault and refuses every other failure', () => {
  for (const [log, signature] of SAMPLES) expect(infrastructureFaultSignature(log)).toBe(signature);
  expect(infrastructureRetrySummary('tests/a.test.ts', 'TypeError: Unable to connect'))
    .toBe('- Infrastructure retry: tests/a.test.ts (TypeError: Unable to connect)');
});

test('the pull request plan refuses runner time over the budget and accepts time within it', () => {
  const plan = { ordinary: [
    { kind: 'node', shard: '1/2', phases: [{ estimatedMs: 70_000 }, { estimatedMs: 20_000 }] },
    { kind: 'dom', shard: '1/1', phases: [{ estimatedMs: 500_000 }] },
  ] };
  expect(plannedNodeRunnerMs(plan)).toBe(90_000);
  const over = checkTestBudget({ plan, skipRatio: true, budgetMs: 60_000 });
  expect(over).toHaveLength(1);
  expect(over[0]).toContain('90s (1m 30s)');
  expect(over[0]).toContain('60s (1m 0s)');
  expect(over[0]).toContain('Make room by deleting or demoting tests, never by raising the budget.');
  expect(checkTestBudget({ plan, skipRatio: true, budgetMs: 90_000 })).toEqual([]);
  expect(() => assertRunnerBudget(PR_NODE_RUNNER_BUDGET_MS + 1)).toThrow(/never by raising the budget/);
  expect(() => assertRunnerBudget(PR_NODE_RUNNER_BUDGET_MS)).not.toThrow();
});

test('the line ratio may not rise while it is above 1, and states both ratios and the lines added', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'test-budget-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', fixture, '-c', 'user.email=budget@example.com', '-c', 'user.name=budget', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  const write = (file: string, text: string) => {
    const target = path.join(fixture, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  try {
    const source = (...parts: string[]) => path.join(...parts);
    git('init', '-q');
    write(source('tests', 'a.test.ts'), 'one\ntwo\n');
    write(source('packages', 'demo', 'src', 'app.ts'), 'a\nb\nc\nd\n');
    write(source('packages', 'demo', 'src', 'skip.generated.ts'), 'not\ncounted\nas\nproduct\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    expect(lineCountsAt(fixture, base)).toEqual({ test: 2, product: 4 });
    expect(countLines('a\nb')).toBe(2);
    write(source('tests', 'b.test.ts'), '1\n2\n3\n4\n');
    git('add', '.');
    git('commit', '-q', '-m', 'grew');
    const before = lineCountsAt(fixture, base);
    const after = lineCountsAt(fixture, 'HEAD');
    expect(ratioRoseAboveOne(before, after)).toBe(true);
    const refusal = ratioRefusal(before, after);
    expect(refusal).toContain(formatRatio(before));
    expect(refusal).toContain(formatRatio(after));
    expect(refusal).toContain('4 test lines added');
    expect(checkTestBudget({ repo: fixture, base, skipPlan: true })).toEqual([refusal]);
    write(source('tests', 'b.test.ts'), '1\n2\n3\n');
    git('add', '.');
    git('commit', '-q', '-m', 'shrunk');
    const shrunk = lineCountsAt(fixture, 'HEAD');
    expect(shrunk).toEqual({ test: 5, product: 4 });
    expect(ratioRoseAboveOne(after, shrunk)).toBe(false);
    expect(checkTestBudget({ repo: fixture, base: git('rev-parse', 'HEAD~1').trim(), skipPlan: true })).toEqual([]);
    const under = { test: 2, product: 4 };
    const stillUnder = { test: 3, product: 4 };
    expect(ratioRoseAboveOne(under, stillUnder)).toBe(false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
