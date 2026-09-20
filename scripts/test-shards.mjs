export function parseShard(value) {
  if (value === undefined) return { index: 1, count: 1 };
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(value)) throw new Error(`Invalid shard: ${value}; expected index/count`);
  const [index, count] = value.split('/').map(Number);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index > count || count > 256) {
    throw new Error(`Invalid shard: ${value}; require 1 <= index <= count <= 256`);
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
