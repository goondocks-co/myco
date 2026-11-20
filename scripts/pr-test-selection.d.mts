export function isTestFile(file: string): boolean;
export function affectedTests(input: { root: string; files: string[]; changed: string[] }): Array<{ file: string; tier: number }>;
