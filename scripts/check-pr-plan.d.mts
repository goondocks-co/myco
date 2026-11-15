export interface ConsumerRow {
  name: string;
  ci: string;
  when: { paths?: string[]; tests?: string[] | 'windows-native'; changed?: (paths: string[]) => boolean };
  tests?: string[];
  check?: string;
  ciOnly?: string;
}
export interface BuildStep { cwd: string; command: string; from: string }
export const CONSUMERS: ConsumerRow[];
export function pathMatches(pattern: string, file: string): boolean;
export function workflowStepTests(root: string, job: string, stepName: string): string[];
export function selectConsumers(input: { changed: string[]; tests: string[]; windowsTests: string[] }): Array<ConsumerRow & { reasons: string[] }>;
export function rowTestFiles(row: ConsumerRow, files: string[]): string[];
export function buildSteps(root: string): BuildStep[];
export function parseArgs(argv: string[], cpus: number): { skipImporters: boolean; jobs: number };
export function summaryLine(input: { passed: number; failed: number; seconds: number; base: string; notRun: Array<{ what: string; why: string }> }): string;
