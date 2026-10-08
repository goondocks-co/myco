export function sandboxPath(home: string, incomingPath?: string): string;
export function sandboxTestHome(root: string): string;
export const CHILD_HOME_NAMES: readonly string[];
export function assertSandboxChildEnv(root: string, env: NodeJS.ProcessEnv): void;
export function sandboxChildEnv(root: string, overrides?: NodeJS.ProcessEnv, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function bindSandboxChildHome(root: string, overrides?: NodeJS.ProcessEnv): () => void;
export function assertTestPath(root: string, candidate: string | undefined, label: string): void;
