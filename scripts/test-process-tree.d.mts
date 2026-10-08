export function registerTestProcess(child: { pid?: number; kill(signal: NodeJS.Signals): unknown }, root?: string): void;
export function stopTestProcessGroup(pid: number, signal: NodeJS.Signals, root?: string): void;
export function stopRegisteredTestProcesses(root?: string): void;
export function useTestProcessIdentityReader(reader?: (pid: number) => string | null): () => void;
export function readTestProcessRssKiB(pid: number): number;
export function readTestProcessState(pid: number, override?: string): string | null;
export function readTestProcessGroupId(pid: number): number;
export function readTestProcessTable(): Map<number, { ppid: number; pgid: number; started: string }>;
export function readTestProcessCommands(pids: number[]): string;
