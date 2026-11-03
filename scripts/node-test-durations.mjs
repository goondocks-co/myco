// Refresh: download node artifacts from N green runs, replace node-ci-durations.json runs, then run node scripts/node-test-durations.mjs tests/fixtures/runner/node-ci-durations.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { format } from 'node:util';
import { SaxesParser } from 'saxes';
import { DEFAULT_TEST_TIMEOUT_MS } from './test-shards.mjs';

const MAX_GROUP_JOB_SHARE = 1 / 4;
const MAX_NODE_MEASURED_MS = 11 * 60_000;

export function nodeGroupBudget(timeoutMs) {
  return timeoutMs * MAX_GROUP_JOB_SHARE;
}

/** Allocate each recorded process's wall time to its files, including startup. */
export function nodeDurationSamples(workload) {
  return workload.runs.map(({ source, shardCount, shards }) => {
    assert.ok(Number.isSafeInteger(shardCount) && shardCount > 0, `${source}: invalid recorded shard count`);
    const files = {};
    assert.deepEqual(shards.map(shard => shard.shard).sort((left, right) => left - right), Array.from({ length: shardCount }, (_, index) => index + 1), `${source}: incomplete node workload`);
    for (const { groups } of shards) for (const group of groups) {
      const total = Object.values(group.files).reduce((sum, milliseconds) => sum + milliseconds, 0);
      assert.ok(total > 0, `${source}: group needs positive recorded duration`);
      const scale = group.milliseconds / total;
      for (const [file, milliseconds] of Object.entries(group.files)) {
        assert.ok(!(file in files), `${source}: duplicate file ${file}`);
        const split = group.splits?.[file];
        if (split) {
          assert.ok(split.milliseconds > 0 && split.milliseconds < milliseconds, `${source}: invalid split`);
          files[split.file] = split.milliseconds * scale;
        }
        files[file] = (milliseconds - (split?.milliseconds ?? 0)) * scale;
      }
    }
    return { source, files };
  });
}

export function recordedNodeDurations(workload) {
  const weights = {};
  for (const { files } of nodeDurationSamples(workload)) for (const [file, milliseconds] of Object.entries(files)) {
    weights[file] = Math.max(weights[file] ?? 0, Math.ceil(milliseconds));
  }
  return weights;
}

export function mergeNodeDurationWeights(weights, workload) {
  const recorded = recordedNodeDurations(workload);
  const merged = { ...weights };
  for (const [file, milliseconds] of Object.entries(recorded)) merged[file] = Math.max(weights[file] ?? 0, milliseconds);
  const introduced = new Map();
  for (const run of workload.runs) for (const shard of run.shards) for (const group of shard.groups) {
    for (const [source, split] of Object.entries(group.splits ?? {})) {
      if (Object.hasOwn(weights, split.file)) continue;
      const targets = introduced.get(source) ?? new Set();
      targets.add(split.file);
      introduced.set(source, targets);
    }
  }
  for (const [source, targets] of introduced) {
    const carried = [...targets].reduce((sum, file) => sum + merged[file], 0);
    merged[source] = Math.max(recorded[source] ?? 0, merged[source] - carried);
  }
  return merged;
}

/** Bound measured shard work and reserve one job share for runner and setup variance. */
export function assertNodeShardHeadroom(plans, timeoutMs, weights, workload) {
  const groupBudget = nodeGroupBudget(timeoutMs);
  const shardBudget = Math.min(timeoutMs - timeoutMs / plans.length, MAX_NODE_MEASURED_MS);
  const recorded = recordedNodeDurations(workload);
  for (const file of plans.flatMap(plan => plan.flatMap(group => group.files))) {
    assert.ok(Number.isFinite(weights[file]) && weights[file] > 0, `Node file needs an explicit duration weight: ${file}; add "${file}": <ms> to scripts/test-durations.json, using its measured npm test time.`);
    if (recorded[file] !== undefined) assert.ok(weights[file] >= recorded[file], `Stale node duration: ${file}; recorded ${recorded[file]}ms, configured ${weights[file]}ms`);
  }
  for (const [index, plan] of plans.entries()) {
    for (const group of plan) {
      const milliseconds = group.files.reduce((total, file) => total + weights[file], 0);
      assert.ok(milliseconds <= groupBudget, `Node group ${group.label}: ${milliseconds}ms exceeds ${groupBudget}ms; split the group: ${group.files.join(', ')}`);
    }
    const estimated = plan.reduce((sum, group) => sum + group.estimatedMs, 0);
    assert.ok(estimated <= shardBudget, `Node shard ${index + 1}: ${estimated}ms exceeds ${shardBudget}ms with headroom`);
    for (const sample of nodeDurationSamples(workload)) {
      const groupTimes = plan.map(group => {
        const milliseconds = group.files.reduce((total, file) => total + (sample.files[file] ?? weights[file]), 0);
        assert.ok(milliseconds <= groupBudget, `${sample.source}: node group ${group.label}: ${Math.ceil(milliseconds)}ms exceeds ${groupBudget}ms; split the group: ${group.files.join(', ')}`);
        return milliseconds;
      });
      const replayed = groupTimes.reduce((sum, milliseconds) => sum + milliseconds, 0);
      assert.ok(replayed <= shardBudget, `${sample.source}: node shard ${index + 1} replays at ${Math.ceil(replayed)}ms, exceeds ${shardBudget}ms with headroom`);
    }
  }
}

const MAX_TEST_TIMEOUT_SHARE = 0.8;

export function assertTestCaseHeadroom(samples, timeoutFor) {
  assert.ok(samples.some(run => run.tests.length > 0), 'Per-test headroom needs measured cases');
  for (const { source, tests } of samples) for (const test of tests) {
    const timeoutMs = timeoutFor(test);
    assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, `${test.file}: missing declared test timeout: ${test.name}`);
    assert.ok(Number.isFinite(test.milliseconds) && test.milliseconds >= 0, `${source}: missing measured test duration: ${test.name}`);
    assert.ok(test.milliseconds <= timeoutMs * MAX_TEST_TIMEOUT_SHARE,
      `${source}: ${test.file}: ${test.name}: ${test.milliseconds}ms exceeds ${MAX_TEST_TIMEOUT_SHARE * 100}% of its ${timeoutMs}ms test timeout`);
  }
}

const timeoutSources = new Map();
let timeoutParser;

export function declaredTestTimeout(root, test) {
  const ts = timeoutParser ??= createRequire(import.meta.url)('typescript-v6');
  const filename = path.resolve(root, test.file);
  let inventory = timeoutSources.get(filename);
  if (inventory === undefined) {
    const source = ts.createSourceFile(test.file, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    const constants = new Map(), calls = [];
    const testRoot = expression => ts.isIdentifier(expression) ? ['it', 'test'].includes(expression.text)
      : ts.isPropertyAccessExpression(expression) || ts.isCallExpression(expression) ? testRoot(expression.expression) : false;
    const visit = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
      if (ts.isCallExpression(node) && testRoot(node.expression) && node.arguments.length >= 2) {
        const name = node.arguments[0];
        const pattern = ts.isStringLiteralLike(name) ? name.text : '%';
        let names = [pattern];
        if (ts.isCallExpression(node.expression)) {
          const each = node.expression;
          let values = each.arguments[0];
          if (values && ts.isAsExpression(values)) values = values.expression;
          if (ts.isPropertyAccessExpression(each.expression) && each.expression.name.text === 'each' && values && ts.isArrayLiteralExpression(values)) {
            names = values.elements.filter(ts.isStringLiteralLike).map(value => format(pattern, value.text));
          }
        }
        calls.push({ names, pattern, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, timeout: node.arguments[2] });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    inventory = { constants, calls };
    timeoutSources.set(filename, inventory);
  }
  const numberOf = (node, seen = new Set()) => {
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isParenthesizedExpression(node)) return numberOf(node.expression, seen);
    if (ts.isIdentifier(node) && inventory.constants.has(node.text) && !seen.has(node.text))
      return numberOf(inventory.constants.get(node.text), new Set([...seen, node.text]));
    if (ts.isBinaryExpression(node)) {
      const left = numberOf(node.left, seen), right = numberOf(node.right, seen);
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: return left + right;
        case ts.SyntaxKind.MinusToken: return left - right;
        case ts.SyntaxKind.AsteriskToken: return left * right;
        case ts.SyntaxKind.SlashToken: return left / right;
      }
    }
    throw new Error(`${test.file}:${test.line}: cannot resolve declared test timeout`);
  };
  const matches = inventory.calls.filter(({ names, pattern, line }) => names.includes(test.name)
    || line === test.line && names.length === 1 && names[0] === pattern && pattern.includes('%'));
  assert.equal(matches.length, 1, `${test.file}:${test.line}: expected one declared test matching its recorded name`);
  return matches[0].timeout === undefined ? DEFAULT_TEST_TIMEOUT_MS : numberOf(matches[0].timeout);
}

export function testDurationSamples(xml) {
  const tests = [];
  let current;
  const parser = new SaxesParser();
  parser.on('error', error => { throw error; });
  parser.on('opentag', ({ name, attributes }) => {
    if (name === 'testcase') current = { file: attributes.file, name: attributes.name,
      line: Number(attributes.line), milliseconds: attributes.time === undefined || attributes.time.trim() === '' ? NaN : Number(attributes.time) * 1000 };
    if (name === 'skipped' && current) current.skipped = true;
  });
  parser.on('closetag', ({ name }) => {
    if (name !== 'testcase') return;
    if (!current.skipped) tests.push(current);
    current = undefined;
  });
  parser.write(xml).close();
  return tests;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const target = new URL('./test-durations.json', import.meta.url);
  const durations = JSON.parse(fs.readFileSync(target, 'utf8'));
  durations.files = mergeNodeDurationWeights(durations.files, workload);
  durations.files = Object.fromEntries(Object.entries(durations.files).sort(([left], [right]) => left.localeCompare(right)));
  const provenance = new URL('./test-duration-sources.json', import.meta.url);
  const sources = JSON.parse(fs.readFileSync(provenance, 'utf8'));
  fs.writeFileSync(provenance, JSON.stringify([...new Set([...sources, ...workload.runs.map(run => run.source)])], null, 2) + '\n');
  fs.writeFileSync(target, JSON.stringify(durations, null, 2) + '\n');
}
