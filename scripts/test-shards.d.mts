export interface Shard { index: number; count: number }
export const PARITY_PLAN_PREFIX: string;
export const VIEW_PROOF_FILES: readonly string[];
export function groupByDuration<T>(items: T[], budgetMs: number, weight: (item: T) => number, maxItems?: number): T[][];
export function parseShard(value: string | undefined): Shard;
export function selectShard<T>(items: T[], shard: Shard, weight?: (item: T) => number): T[];
export function selectGroup<T extends { label: string }>(groups: T[], label: string | undefined): T[];
