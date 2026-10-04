export function sweepStaleRunRoots(parent: string): number;
export function systemTempDirectories(): string[];
export function snapshotTestTemps(directories: string[]): Map<string, Set<string>>;
export function newTestTemps(before: Map<string, Set<string>>, startedAt: number, root: string): string[];
export function createTestTempRun(options?: { parent?: string; directories?: string[] }): {
  root: string;
  finish(): string[];
};
export function finishTestTempRun(run: { finish(): string[] }, beforeCleanup?: () => void): void;
