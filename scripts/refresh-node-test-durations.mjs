// Download the last N green main CI runs that ran the current node matrix, replace the recorded
// runs, and merge those times into scripts/test-durations.json.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testsMatrixInclude, workloadRun } from './node-report-workload.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const count = Number(process.argv[2] ?? 3);
if (!Number.isSafeInteger(count) || count < 1) throw new Error('refresh count must be a positive integer');

function gh(args) {
  return execFileSync('gh', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const listed = JSON.parse(gh(['run', 'list', '--branch', 'main', '--workflow', 'CI', '--status', 'success', '--limit', '40', '--json', 'databaseId,url,displayTitle']));
const include = testsMatrixInclude(fs.readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8'));
const nodeSlots = include.filter(entry => entry.kind === 'node').length;
const chosen = [];
for (const run of listed) {
  if (chosen.length >= count) break;
  const names = gh(['api', '--paginate', `repos/goondocks-co/myco/actions/runs/${run.databaseId}/artifacts`, '--jq', '.artifacts[].name']);
  const nodeArtifacts = names.split('\n').filter(name => /^test-reports-node-\d+$/.test(name));
  if (nodeArtifacts.length !== nodeSlots) continue;
  chosen.push(run);
}
if (chosen.length < count) throw new Error(`found ${chosen.length} green main runs with ${nodeSlots} node shards; need ${count}`);

const downloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-duration-refresh-'));
try {
  const runs = [];
  for (const run of chosen) {
    const dest = path.join(downloadRoot, String(run.databaseId));
    fs.mkdirSync(dest);
    gh(['run', 'download', String(run.databaseId), '--pattern', 'test-reports-node-*', '--dir', dest]);
    runs.push(workloadRun(dest, run.url, include));
    console.log(`recorded ${run.databaseId}: ${runs.at(-1).shards.length} node shards`);
  }
  const fixturePath = path.join(repo, 'tests/fixtures/runner/node-ci-durations.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  fixture.runs = runs;
  fs.writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`);
  execFileSync(process.execPath, ['scripts/node-test-durations.mjs', 'tests/fixtures/runner/node-ci-durations.json'], { cwd: repo, stdio: 'inherit' });
  const provenancePath = path.join(repo, 'scripts/test-duration-sources.json');
  const sources = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  const ids = chosen.map(run => run.databaseId).join(', ');
  const sentence = `ci: node duration refresh from test-reports-node-* artifacts of green main runs ${ids} (${nodeSlots} node shards each). A file's recorded time is its JUnit file-suite time scaled to the phase FINISHED wall time; node-test-durations.mjs keeps the max of that time and the previous weight.`;
  if (!sources.includes(sentence)) sources.push(sentence);
  fs.writeFileSync(provenancePath, `${JSON.stringify(sources, null, 2)}\n`);
  console.log(sentence);
} finally {
  fs.rmSync(downloadRoot, { recursive: true, force: true });
}
