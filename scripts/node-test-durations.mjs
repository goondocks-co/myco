// Refresh: npm run refresh:node-durations
// Downloads node artifacts from the last N green main runs, replaces node-ci-durations.json runs, then merges weights.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
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

/** Every node file carries a positive weight no lower than its recorded time. */
export function assertNodeShardWeights(plans, weights, workload) {
  const recorded = recordedNodeDurations(workload);
  for (const file of plans.flatMap(plan => plan.flatMap(group => group.files))) {
    assert.ok(Number.isFinite(weights[file]) && weights[file] > 0, `Node file needs an explicit duration weight: ${file}; add "${file}": <ms> to scripts/test-durations.json, using its measured npm test time.`);
    if (recorded[file] !== undefined) assert.ok(weights[file] >= recorded[file], `Stale node duration: ${file}; recorded ${recorded[file]}ms, configured ${weights[file]}ms`);
  }
}

/** Bound measured shard work and reserve one job share for runner and setup variance. */
export function assertNodeShardBudgets(plans, timeoutMs, weights, workload) {
  const groupBudget = nodeGroupBudget(timeoutMs);
  const shardBudget = Math.min(timeoutMs - timeoutMs / plans.length, MAX_NODE_MEASURED_MS);
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

export function assertNodeShardHeadroom(plans, timeoutMs, weights, workload) {
  assertNodeShardWeights(plans, weights, workload);
  assertNodeShardBudgets(plans, timeoutMs, weights, workload);
}

const MAX_TEST_TIMEOUT_SHARE = 0.8;

/** Each recorded case past its share of its declared timeout, as one message per case. */
export function testCaseHeadroomBreaches(samples, timeoutFor) {
  assert.ok(samples.some(run => run.tests.length > 0), 'Per-test headroom needs measured cases');
  const breaches = [];
  for (const { source, tests } of samples) for (const test of tests) {
    const timeoutMs = timeoutFor(test);
    assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, `${test.file}: missing declared test timeout: ${test.name}`);
    assert.ok(Number.isFinite(test.milliseconds) && test.milliseconds >= 0, `${source}: missing measured test duration: ${test.name}`);
    if (test.milliseconds > timeoutMs * MAX_TEST_TIMEOUT_SHARE) {
      breaches.push(`${source}: ${test.file}: ${test.name}: ${test.milliseconds}ms exceeds ${MAX_TEST_TIMEOUT_SHARE * 100}% of its ${timeoutMs}ms test timeout`);
    }
  }
  return breaches;
}

export function assertTestCaseHeadroom(samples, timeoutFor) {
  const breaches = testCaseHeadroomBreaches(samples, timeoutFor);
  assert.equal(breaches.length, 0, breaches[0]);
}

const timeoutSources = new Map();
let timeoutParser;

export function declaredTestTimeout(root, test) {
  const ts = timeoutParser ??= createRequire(import.meta.url)('typescript-v6');
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  assert.ok(!config.error, `${root}: cannot read timeout resolution configuration`);
  const converted = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, root);
  assert.equal(converted.errors.length, 0, `${root}: invalid timeout resolution configuration`);
  const options = converted.options;
  const inventoryFor = filename => {
    if (timeoutSources.has(filename)) return timeoutSources.get(filename);
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    assert.equal(source.parseDiagnostics.length, 0, `${filename}: invalid test source`);
    const constants = new Map(), imports = new Map(), calls = [];
    const inventory = { source, constants, imports, calls };
    timeoutSources.set(filename, inventory);
    const rootOf = expression => ts.isIdentifier(expression) ? expression.text
      : ts.isPropertyAccessExpression(expression) || ts.isCallExpression(expression) ? rootOf(expression.expression) : '';
    const visit = (node, scopes = []) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, [...(constants.get(node.name.text) ?? []), node.initializer]);
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const binding of node.importClause.namedBindings.elements) imports.set(binding.name.text, {
          module: node.moduleSpecifier.text, name: (binding.propertyName ?? binding.name).text,
        });
      }
      if (ts.isCallExpression(node) && ['it', 'test', 'describe'].includes(rootOf(node.expression)) && node.arguments.length >= 2) {
        if (rootOf(node.expression) === 'describe') scopes = [...scopes, node.arguments[0]];
        else calls.push({ name: node.arguments[0], scopes, timeout: node.arguments[2],
          line: source.getLineAndCharacterOfPosition(node.arguments[0].getStart(source)).line + 1 });
      }
      ts.forEachChild(node, child => visit(child, scopes));
    };
    visit(source);
    return inventory;
  };
  const scopeOf = node => ts.findAncestor(node.parent, owner => ts.isBlock(owner) || ts.isSourceFile(owner) || ts.isForOfStatement(owner) || ts.isForStatement(owner));
  const valueOf = (node, inventory, seen = new Set()) => {
    assert.ok(node && !seen.has(node), `${test.file}:${test.line}: cannot resolve declared test timeout or name`);
    seen = new Set([...seen, node]);
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return valueOf(node.expression, inventory, seen);
    if (ts.isIdentifier(node)) {
      for (let scope = node.parent; scope; scope = scope.parent) {
        const locals = (inventory.constants.get(node.text) ?? []).filter(initializer => scopeOf(initializer) === scope);
        if (locals.length) {
          assert.equal(locals.length, 1, `${test.file}: ambiguous timeout constant ${node.text}`);
          return valueOf(locals[0], inventory, seen);
        }
      }
      const imported = inventory.imports.get(node.text);
      if (imported) {
        const resolved = ts.resolveModuleName(imported.module, inventory.source.fileName, options, ts.sys).resolvedModule;
        assert.ok(resolved, `${test.file}: cannot resolve timeout import ${imported.module}`);
        const dependency = inventoryFor(resolved.resolvedFileName);
        const exported = (dependency.constants.get(imported.name) ?? []).filter(node => scopeOf(node) === dependency.source);
        assert.equal(exported.length, 1, `${test.file}: cannot resolve imported timeout ${imported.name}`);
        return valueOf(exported[0], dependency, seen);
      }
    }
    if (ts.isBinaryExpression(node)) {
      const left = valueOf(node.left, inventory, seen), right = valueOf(node.right, inventory, seen);
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: return left + right;
        case ts.SyntaxKind.MinusToken: return left - right;
        case ts.SyntaxKind.AsteriskToken: return left * right;
        case ts.SyntaxKind.SlashToken: return left / right;
      }
    }
    throw new Error(`${test.file}:${test.line}: cannot resolve declared test timeout or name: ${node.getText()}`);
  };
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patternOf = (node, inventory) => {
    if (ts.isTemplateExpression(node)) return escape(node.head.text) + node.templateSpans.map(span => '[\\s\\S]*' + escape(span.literal.text)).join('');
    if (ts.isConditionalExpression(node)) return '(?:' + (patternOf(node.whenTrue, inventory) ?? '[\\s\\S]*') + '|' + (patternOf(node.whenFalse, inventory) ?? '[\\s\\S]*') + ')';
    if (!ts.isStringLiteralLike(node)) return undefined;
    return escape(node.text).replace(/%[sdifjoOp#%$]|\\?\$[a-zA-Z_]\w*(?:\\.\w+)*/g, '[\\s\\S]*');
  };
  const files = test.file.startsWith('target/test-bundles/') ? test.sourceFiles : [test.file];
  assert.ok(Array.isArray(files) && files.length > 0, `${test.file}: missing persisted bundle source list`);
  const inventories = files.map(file => inventoryFor(path.resolve(root, file)));
  let matches = inventories.flatMap(inventory => inventory.calls.flatMap(call => {
    const pattern = patternOf(call.name, inventory);
    const scopes = [...call.scopes].reverse().map(node => patternOf(node, inventory));
    const scope = scopes.map(pattern => pattern ?? '[\\s\\S]*').join(' > ');
    const located = call.line === test.line;
    const named = pattern === undefined ? located : new RegExp('^' + pattern + '$').test(test.name);
    const scoped = test.classname === undefined || new RegExp('^' + scope + '$').test(test.classname);
    return named && scoped && (scopes.every(pattern => pattern !== undefined) || located) ? [{ ...call, inventory }] : [];
  }));
  if (matches.length > 1) matches = matches.filter(call => call.line === test.line);
  assert.equal(matches.length, 1, `${test.file}:${test.line}: expected one declared test matching its recorded name and classname: ${test.classname ?? ''} > ${test.name}`);
  return matches[0].timeout === undefined ? DEFAULT_TEST_TIMEOUT_MS : valueOf(matches[0].timeout, matches[0].inventory);
}

export function testDurationSamples(xml) {
  const tests = [];
  let current;
  const parser = new SaxesParser();
  parser.on('error', error => { throw error; });
  parser.on('opentag', ({ name, attributes }) => {
    if (name === 'testcase') current = { file: attributes.file, name: attributes.name, classname: attributes.classname,
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
