export interface Shard { index: number; count: number }
export function parseShard(value: string | undefined): Shard;
export function selectShard<T>(items: T[], shard: Shard, weight?: (item: T) => number): T[];
