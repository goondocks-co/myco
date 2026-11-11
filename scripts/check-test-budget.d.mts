export const PR_NODE_RUNNER_BUDGET_MS: number;
export const UNRECORDED_PR_FILE_FLOOR_MS: number;

export function roundUpFiveMinutes(milliseconds: number): number;

export interface PlannedPhase { files?: string[]; estimatedMs?: number }
export interface PlannedShard { kind: string; phases?: PlannedPhase[] }
export interface PlannedMatrix { ordinary?: PlannedShard[] }
export function nodePlanFiles(matrix: PlannedMatrix): string[];

export function chargeNodeFiles(
  files: string[],
  declared: Record<string, number>,
  recorded: Record<string, number>,
  floor?: number,
): { total: number; atFloor: string[] };

export function formatRunnerTime(milliseconds: number): string;
export function runnerBudgetRefusal(actualMs: number, budgetMs?: number, floorFiles?: string[]): string;
export function assertRunnerBudget(actualMs: number, budgetMs?: number, floorFiles?: string[]): void;

export function isTestLineFile(file: string): boolean;
export function isProductLineFile(file: string): boolean;
export function countLines(text: string): number;

export interface LineCounts { test: number; product: number }
export function formatRatio(counts: LineCounts): string;
export function ratioRoseAboveOne(before: LineCounts, after: LineCounts): boolean;
export function ratioRefusal(before: LineCounts, after: LineCounts): string;
export function lineCountsAt(repo: string, revision: string): LineCounts;

export interface BudgetCheck {
  repo?: string;
  base?: string;
  plan?: PlannedMatrix;
  declared?: Record<string, number>;
  recorded?: Record<string, number>;
  budgetMs?: number;
  skipRatio?: boolean;
  skipPlan?: boolean;
}
export function checkTestBudget(options?: BudgetCheck): string[];
