const MAX_SHARDS = 256;
export const PARITY_PLAN_PREFIX = '[myco-parity-plan] ';
export const VIEW_PROOF_FILES = Object.freeze([
  'tests/myco-server/view-read-costs.test.ts',
  'tests/myco-server/view-read-oracle.test.ts',
  'tests/myco-server/view-read-intrinsic-costs.test.ts',
  'tests/myco-server/view-records.test.ts',
  'tests/myco-server/view-sessions.test.ts',
  'tests/myco-server/view-source-closure.test.ts',
  'tests/myco-server/view-read-legacy.test.ts',
  'tests/myco-server/view-lifecycle.test.ts',
  'tests/myco-server/view-writer-throughput.test.ts',
  'tests/meta/view-read-boundary.test.ts',
]);

/** Fill execution groups in input order within duration and worker limits. */
export function groupByDuration(items, budgetMs, weight, maxItems = Infinity) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Group budget must be positive and finite');
  if (maxItems !== Infinity && (!Number.isSafeInteger(maxItems) || maxItems <= 0)) throw new Error('Group item limit must be a positive integer');
  const groups = [];
  let group = [];
  let elapsed = 0;
  for (const item of items) {
    const duration = weight(item);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Group weights must be positive and finite');
    if (group.length > 0 && (group.length >= maxItems || elapsed + duration > budgetMs)) {
      groups.push(group);
      group = [];
      elapsed = 0;
    }
    group.push(item);
    elapsed += duration;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

/** Select one intact group from an already assigned shard. */
export function selectGroup(groups, label) {
  if (label === undefined) return groups;
  const selected = groups.filter((group) => group.label === label);
  if (selected.length === 0) throw new Error(`Group ${label} is not in the selected shard`);
  return selected;
}

export function parseShard(value) {
  if (value === undefined) return { index: 1, count: 1 };
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(value)) throw new Error(`Invalid shard: ${value}; expected index/count`);
  const [index, count] = value.split('/').map(Number);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index > count || count > MAX_SHARDS) {
    throw new Error(`Invalid shard: ${value}; require 1 <= index <= count <= ${MAX_SHARDS}`);
  }
  return { index, count };
}

/** Assign whole items by estimated duration, retaining their original execution order. */
export function selectShard(items, shard, weight = () => 1) {
  const loads = Array(shard.count).fill(0);
  const assignments = new Map();
  items.map((item, index) => ({ index, weight: weight(item) }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .forEach(({ index, weight: duration }) => {
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Shard weights must be positive and finite');
      const destination = loads.indexOf(Math.min(...loads));
      assignments.set(index, destination + 1);
      loads[destination] += duration;
    });
  const selected = items.filter((_, index) => assignments.get(index) === shard.index);
  if (selected.length === 0) throw new Error(`Shard ${shard.index}/${shard.count} contains no tests`);
  return selected;
}
