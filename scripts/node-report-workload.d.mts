export const DURATION_DRIFT_FACTOR: number;
export function fileSuiteMilliseconds(xml: string): Record<string, number>;
export function caseMilliseconds(xml: string): { file: string; name: string; milliseconds: number }[];
export function phaseOutcome(log: string): { label: string; milliseconds: number; killed: boolean } | null;
export function phaseGroup(log: string, xml: string): { label: string; milliseconds: number; files: Record<string, number> };
export function artifactGroups(artifactDirectory: string): {
  groups: { label: string; milliseconds: number; files: Record<string, number> }[];
  killed: { label: string; milliseconds: number }[];
  reports: string[];
};
export function nodeArtifactShard(artifactName: string, include: { kind: string; shard: string }[]): { shard: number; shardCount: number } | null;
export function testsMatrixInclude(workflowYaml: string): { kind: string; shard: string }[];
export function workloadRun(downloadDirectory: string, source: string, include: { kind: string; shard: string }[]): {
  source: string;
  shardCount: number;
  shards: { shard: number; groups: { label: string; milliseconds: number; files: Record<string, number> }[] }[];
};
export function durationDrift(groups: { label: string; milliseconds: number; files: Record<string, number> }[], weights: Record<string, number>, groupBudget: number, factor?: number): {
  files: { file: string; milliseconds: number; weight: number | null }[];
  groups: { label: string; milliseconds: number }[];
  groupBudget: number;
};
export function driftSummary(drift: {
  files: { file: string; milliseconds: number; weight: number | null }[];
  groups: { label: string; milliseconds: number }[];
  groupBudget: number;
  killed?: { label: string; milliseconds: number }[];
  reports?: string[];
}): string;
export function nodePackingBudget(workflowYaml: string): number;
