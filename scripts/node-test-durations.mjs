import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_GROUP_JOB_SHARE = 1 / 4;

/** Allocate each recorded process's wall time to its files, including startup. */
export function nodeDurationSamples(workload) {
  return workload.runs.map(({ source, shards }) => {
    const files = {};
    assert.deepEqual(shards.map(shard => shard.shard).sort((left, right) => left - right), Array.from({ length: shards.length }, (_, index) => index + 1), `${source}: incomplete shard sequence`);
    for (const { groups } of shards) for (const group of groups) {
      const total = group.files.reduce((sum, file) => sum + file.milliseconds, 0);
      assert.ok(total > 0, `${source}: group needs positive recorded duration`);
      const scale = group.milliseconds / total;
      for (const file of group.files) {
        assert.ok(!(file.file in files), `${source}: duplicate file ${file.file}`);
        const split = file.split;
        if (split) {
          assert.ok(split.milliseconds > 0 && split.milliseconds < file.milliseconds, `${source}: invalid split`);
          files[split.file] = split.milliseconds * scale;
        }
        files[file.file] = (file.milliseconds - (split?.milliseconds ?? 0)) * scale;
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

/** Reserve one equal share of the job budget for runner and setup variance. */
export function assertNodeShardHeadroom(plans, timeoutMs, weights, workload) {
  const groupBudget = timeoutMs * MAX_GROUP_JOB_SHARE;
  const shardBudget = timeoutMs - timeoutMs / plans.length;
  for (const run of workload.runs) assert.equal(run.shards.length, plans.length, `${run.source}: incomplete node workload`);
  const recorded = recordedNodeDurations(workload);
  for (const file of plans.flatMap(plan => plan.flatMap(group => group.files))) {
    assert.ok(Number.isFinite(weights[file]) && weights[file] > 0, `Node file needs an explicit duration weight: ${file}`);
    if (recorded[file] !== undefined) assert.ok(weights[file] >= recorded[file], `Stale node duration: ${file}; recorded ${recorded[file]}ms, configured ${weights[file]}ms`);
  }
  for (const [index, plan] of plans.entries()) {
    const estimated = plan.reduce((sum, group) => sum + group.estimatedMs, 0);
    assert.ok(estimated <= shardBudget, `Node shard ${index + 1}: ${estimated}ms exceeds ${shardBudget}ms with headroom`);
    for (const sample of nodeDurationSamples(workload)) {
      const groupTimes = plan.map(group => {
        const milliseconds = group.files.reduce((total, file) => total + (sample.files[file] ?? weights[file]), 0);
        assert.ok(milliseconds <= groupBudget, `${sample.source}: node group ${group.label}: ${Math.ceil(milliseconds)}ms exceeds ${groupBudget}ms; split the group`);
        return milliseconds;
      });
      const replayed = groupTimes.reduce((sum, milliseconds) => sum + milliseconds, 0);
      assert.ok(replayed <= shardBudget, `${sample.source}: node shard ${index + 1} replays at ${Math.ceil(replayed)}ms, exceeds ${shardBudget}ms with headroom`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const target = new URL('./test-durations.json', import.meta.url);
  const durations = JSON.parse(fs.readFileSync(target, 'utf8'));
  Object.assign(durations.files, recordedNodeDurations(workload));
  durations.files = Object.fromEntries(Object.entries(durations.files).sort(([left], [right]) => left.localeCompare(right)));
  durations.sources = [...new Set([...durations.sources, ...workload.runs.map(run => run.source)])];
  fs.writeFileSync(target, JSON.stringify(durations, null, 2) + '\n');
}
