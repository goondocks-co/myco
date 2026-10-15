export interface NodeWorkload {
  runs: {
    source: string;
    shards: {
      shard: number;
      groups: {
        label: string;
        milliseconds: number;
        files: { file: string; milliseconds: number; split?: { file: string; milliseconds: number } }[];
      }[];
    }[];
  }[];
}
export interface NodeGroup { label: string; files: string[]; estimatedMs: number }
export function nodeDurationSamples(workload: NodeWorkload): { source: string; files: Record<string, number> }[];
export function recordedNodeDurations(workload: NodeWorkload): Record<string, number>;
export function assertNodeShardHeadroom(plans: NodeGroup[][], timeoutMs: number, weights: Record<string, number>, workload: NodeWorkload): void;
