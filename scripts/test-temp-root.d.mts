export function sweepStaleRunRoots(parent: string): number;
export function systemTempDirectories(): string[];
export function snapshotTestTemps(directories: string[]): Map<string, Set<string>>;
export function newTestTemps(before: Map<string, Set<string>>, startedAt: number, root: string): string[];
export function createTestTempRun(options?: { parent?: string; directories?: string[] }): {
  root: string;
  strict: boolean;
  finish(): string[];
};
export function finishTestTempRun(run: { finish(): string[]; strict?: boolean }, beforeCleanup?: () => void): void;
