export const installRoots: { directory: string; label: string }[];
export const excludedLockfiles: Record<string, string>;
export function checkTools(root: string, windows?: boolean): void;
export function staleReason(root: string): string | null;
export function ensureDeps(root: string, uiOnly?: boolean): void;
