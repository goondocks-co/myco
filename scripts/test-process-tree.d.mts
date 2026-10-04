export function registerTestProcess(child: { pid?: number; kill(signal: NodeJS.Signals): unknown }, root?: string): void;
export function stopTestProcessGroup(pid: number, signal: NodeJS.Signals, root?: string): void;
export function stopRegisteredTestProcesses(root?: string): void;
export function useTestProcessIdentityReader(reader?: (pid: number) => string | null): () => void;
