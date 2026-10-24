export interface TestDurationSample { file: string; name: string; line: number; milliseconds: number }
export interface TestDurationRun { source: string; tests: TestDurationSample[] }
export interface NodeWorkload {
  testRuns?: TestDurationRun[];
  runs: {
    source: string;
    shardCount: number;
    shards: {
      shard: number;
      groups: {
        label: string;
        milliseconds: number;
        files: Partial<Record<string, number>>;
        splits?: Record<string, { file: string; milliseconds: number }>;
      }[];
    }[];
  }[];
}
export interface NodeGroup { label: string; files: string[]; estimatedMs: number }
export function nodeGroupBudget(timeoutMs: number): number;
export function nodeDurationSamples(workload: NodeWorkload): { source: string; files: Record<string, number> }[];
export function recordedNodeDurations(workload: NodeWorkload): Record<string, number>;
export function assertNodeShardHeadroom(plans: NodeGroup[][], timeoutMs: number, weights: Record<string, number>, workload: NodeWorkload): void;
export function assertTestCaseHeadroom(samples: TestDurationRun[], timeoutFor: (test: TestDurationSample) => number): void;
export function declaredTestTimeout(root: string, test: TestDurationSample): number;
export function testDurationSamples(xml: string): TestDurationSample[];
export function mergeNodeDurationWeights(weights: Record<string, number>, workload: NodeWorkload): Record<string, number>;
