export const PR_NODE_RUNNER_BUDGET_MS: number;

export function roundUpFiveMinutes(milliseconds: number): number;

export interface PlannedPhase { estimatedMs: number }
export interface PlannedShard { kind: string; phases: PlannedPhase[] }
export interface PlannedMatrix { ordinary?: PlannedShard[] }
export function plannedNodeRunnerMs(matrix: PlannedMatrix): number;

export function formatRunnerTime(milliseconds: number): string;
export function runnerBudgetRefusal(actualMs: number, budgetMs?: number): string;
export function assertRunnerBudget(actualMs: number, budgetMs?: number): void;

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
  budgetMs?: number;
  skipRatio?: boolean;
  skipPlan?: boolean;
}
export function checkTestBudget(options?: BudgetCheck): string[];
