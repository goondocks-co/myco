export const installRoots: { directory: string; label: string }[];
export const excludedLockfiles: Record<string, string>;
export function checkTools(root: string, options?: { windows?: boolean; uiOnly?: boolean }): void;
export function staleReason(root: string, host?: { os: string; cpu: string; libc?: string | null }): string | null;
export function ensureDeps(root: string, uiOnly?: boolean): void;
