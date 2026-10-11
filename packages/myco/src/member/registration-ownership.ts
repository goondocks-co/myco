/** File-only ownership signals shared by observation and installation. */
export const MYCO_LAUNCHER_SUBSTRINGS = [
  '.agents/myco-run.cjs',
  '.agents/myco-hook.cjs',
  '.myco/launcher.cjs',
] as const;

export const MYCO_MANAGED_MARKER = '--myco-managed';

export function hasMycoManagedMarker(s: string): boolean {
  return /(?<![\w-])--myco-managed(?![\w-])/.test(s);
}

export function containsMycoLauncherReference(content: string): boolean {
  const normalized = content.replaceAll('\\', '/');
  if (MYCO_LAUNCHER_SUBSTRINGS.some((s) => normalized.includes(s))) return true;
  if (normalized.includes('mcp-launcher.cjs')) return true;
  return false;
}


export const MYCO_MCP_SERVER_NAME = 'myco';
export const rawHasMycoOwnershipSignal = (raw: string): boolean => hasMycoManagedMarker(raw) || containsMycoLauncherReference(raw);
