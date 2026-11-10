// Turn a node shard's test-report artifacts into the workload groups node-test-durations.mjs records.
import fs from 'node:fs';
import path from 'node:path';
import { SaxesParser } from 'saxes';
import { parse } from 'yaml';
import { nodeGroupBudget } from './node-test-durations.mjs';

/** A file ran long enough, against its weight, to call the weight stale. */
export const DURATION_DRIFT_FACTOR = 1.5;

const PHASE_OUTCOME = /\[run-bun-tests\] (?:FINISHED|KILLED \((?:over budget|wedged)\)) (.*?) in (\d+(?:\.\d+)?)ms \(exit /g;

/** Per-test JUnit times. Used to weight a file after it is split. */
export function caseMilliseconds(xml) {
  const cases = [];
  const parser = new SaxesParser();
  parser.on('error', error => { throw error; });
  parser.on('opentag', ({ name, attributes }) => {
    if (name !== 'testcase' || !attributes.file?.startsWith('tests/')) return;
    const seconds = Number(attributes.time);
    cases.push({ file: attributes.file, name: attributes.name ?? '', milliseconds: (Number.isFinite(seconds) && seconds > 0 ? seconds : 0) * 1000 });
  });
  parser.write(xml).close();
  return cases;
}

/** Milliseconds of each file-level JUnit suite. Nested describes are not added again. */
export function fileSuiteMilliseconds(xml) {
  const files = {};
  const parser = new SaxesParser();
  parser.on('error', error => { throw error; });
  parser.on('opentag', ({ name, attributes }) => {
    if (name !== 'testsuite' || attributes.name !== attributes.file || !attributes.file?.startsWith('tests/')) return;
    if (attributes.file in files) return;
    const seconds = Number(attributes.time);
    files[attributes.file] = (Number.isFinite(seconds) && seconds > 0 ? seconds : 0) * 1000;
  });
  parser.write(xml).close();
  return files;
}

/** One phase: its runner label, wall time, and per-file suite times. */
export function phaseGroup(log, xml) {
  const outcomes = [...log.matchAll(PHASE_OUTCOME)];
  if (outcomes.length === 0) throw new Error('phase log has no FINISHED or KILLED line');
  const outcome = outcomes.at(-1);
  const label = outcome[1];
  const milliseconds = Number(outcome[2]);
  if (!(milliseconds > 0)) throw new Error(`${label}: phase wall time is not positive`);
  let files = fileSuiteMilliseconds(xml);
  const recorded = Object.values(files).reduce((sum, time) => sum + time, 0);
  if (!(recorded > 0)) {
    const grouped = [...log.matchAll(/^::group::(tests\/\S+):$/gm)].map(match => match[1]);
    const names = [...new Set(grouped.length > 0 ? grouped : Object.keys(files))];
    if (names.length === 0) throw new Error(`${label}: phase recorded no test file`);
    files = Object.fromEntries(names.map(file => [file, milliseconds / names.length]));
  }
  return { label, milliseconds, files };
}

function runDirectories(directory, found = []) {
  for (const name of fs.readdirSync(directory)) {
    const full = path.join(directory, name);
    let stat;
    try { stat = fs.statSync(full); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isDirectory()) continue;
    if (/^run-/.test(name)) found.push({ full, mtimeMs: stat.mtimeMs });
    else runDirectories(full, found);
  }
  return found;
}

function newestRunDirectory(directory) {
  const found = runDirectories(directory);
  if (found.length === 0) return null;
  found.sort((left, right) => right.mtimeMs - left.mtimeMs || right.full.localeCompare(left.full));
  return found[0].full;
}

/** Groups from one downloaded test-reports-node-* directory, or a test-reports directory. */
export function artifactGroups(artifactDirectory) {
  const runDirectory = newestRunDirectory(artifactDirectory);
  if (!runDirectory) throw new Error(`${path.basename(artifactDirectory)}: no run directory`);
  const groups = [];
  for (const name of fs.readdirSync(runDirectory).filter(file => file.endsWith('.log')).sort()) {
    const xmlPath = path.join(runDirectory, name.replace(/\.log$/, '.junit.xml'));
    if (!fs.existsSync(xmlPath)) throw new Error(`${name}: missing JUnit report`);
    groups.push(phaseGroup(fs.readFileSync(path.join(runDirectory, name), 'utf8'), fs.readFileSync(xmlPath, 'utf8')));
  }
  if (groups.length === 0) throw new Error(`${path.basename(artifactDirectory)}: no phase logs`);
  return groups;
}

/** The node matrix entry an artifact name names, from the workflow's include list. */
export function nodeArtifactShard(artifactName, include) {
  const match = /^test-reports-node-(\d+)$/.exec(artifactName);
  if (!match) return null;
  const entry = include[Number(match[1])];
  if (!entry || entry.kind !== 'node') throw new Error(`${artifactName}: no node matrix entry at that job index`);
  const [shard, shardCount] = String(entry.shard).split('/').map(Number);
  if (!Number.isSafeInteger(shard) || !Number.isSafeInteger(shardCount)) throw new Error(`${artifactName}: invalid shard ${entry.shard}`);
  return { shard, shardCount };
}

export function testsMatrixInclude(workflowYaml) {
  const workflow = parse(workflowYaml);
  const include = workflow?.jobs?.tests?.strategy?.matrix?.include;
  if (!Array.isArray(include) || include.length === 0) throw new Error('CI workflow has no tests matrix');
  return include;
}

/**
 * One recorded run from a directory of downloaded test-reports-node-* artifacts.
 * `source` is the run's public actions URL.
 */
export function workloadRun(downloadDirectory, source, include) {
  const artifactNames = fs.readdirSync(downloadDirectory).filter(name => /^test-reports-node-\d+$/.test(name)).sort((left, right) => Number(left.slice(18)) - Number(right.slice(18)));
  if (artifactNames.length === 0) throw new Error(`${source}: no node test-report artifacts`);
  const shards = artifactNames.map(name => {
    const indexed = nodeArtifactShard(name, include);
    return { ...indexed, groups: artifactGroups(path.join(downloadDirectory, name)) };
  });
  const shardCount = shards[0].shardCount;
  if (shards.some(shard => shard.shardCount !== shardCount)) throw new Error(`${source}: mixed node shard counts`);
  const present = shards.map(shard => shard.shard).sort((left, right) => left - right);
  const expected = Array.from({ length: shardCount }, (_, index) => index + 1);
  if (present.join() !== expected.join()) throw new Error(`${source}: node artifacts do not cover shards 1..${shardCount}`);
  return {
    source,
    shardCount,
    shards: shards.sort((left, right) => left.shard - right.shard).map(({ shard, groups }) => ({ shard, groups })),
  };
}

/** Files over `factor` times their weight, and groups over the packing budget. */
export function durationDrift(groups, weights, groupBudget, factor = DURATION_DRIFT_FACTOR) {
  const files = [];
  for (const group of groups) {
    const recorded = Object.values(group.files).reduce((sum, time) => sum + time, 0);
    if (!(recorded > 0)) throw new Error(`${group.label}: group needs positive recorded duration`);
    const scale = group.milliseconds / recorded;
    for (const [file, time] of Object.entries(group.files)) {
      const milliseconds = time * scale;
      const weight = weights[file];
      if (!(weight > 0) || milliseconds > weight * factor) files.push({ file, milliseconds, weight: weight ?? null });
    }
  }
  files.sort((left, right) => (right.milliseconds / (right.weight || right.milliseconds)) - (left.milliseconds / (left.weight || left.milliseconds)) || left.file.localeCompare(right.file));
  const overBudget = groups.filter(group => group.milliseconds > groupBudget)
    .map(group => ({ label: group.label, milliseconds: group.milliseconds }))
    .sort((left, right) => right.milliseconds - left.milliseconds || left.label.localeCompare(right.label));
  return { files, groups: overBudget, groupBudget };
}

function seconds(milliseconds) {
  return Math.round(milliseconds / 1000);
}

/** Step-summary markdown. Names the refresh command when a weight or a group drifted. */
export function driftSummary(drift) {
  const lines = ['### Node duration drift'];
  if (drift.files.length === 0 && drift.groups.length === 0) {
    lines.push(`No file ran over ${DURATION_DRIFT_FACTOR}× its weight and no group ran over its ${seconds(drift.groupBudget)}s budget.`);
    return lines.join('\n');
  }
  for (const file of drift.files) {
    const weight = file.weight > 0 ? `${seconds(file.weight)}s weight` : 'no weight';
    lines.push(`- \`${file.file}\` ran ${seconds(file.milliseconds)}s against a ${weight}`);
  }
  for (const group of drift.groups) {
    lines.push(`- group \`${group.label}\` ran ${seconds(group.milliseconds)}s against a ${seconds(drift.groupBudget)}s budget`);
  }
  lines.push('Refresh weights from the last green main runs: `npm run refresh:node-durations`');
  return lines.join('\n');
}

export function nodePackingBudget(workflowYaml) {
  const workflow = parse(workflowYaml);
  const timeout = workflow?.jobs?.tests?.['timeout-minutes'];
  if (!(timeout > 0)) throw new Error('CI tests job has no timeout');
  return nodeGroupBudget(timeout * 60_000);
}
