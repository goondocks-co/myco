export function assertServiceCommand(cmd: string[], env: NodeJS.ProcessEnv, cwd?: string): void;
export function serviceGuardEnvironment(root: string, incoming?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function guardedServicePath(env: NodeJS.ProcessEnv): string | undefined;
export function assertNoServiceExecutions(dir: string): void;
export function sandboxServiceChild(cmd: string[], env: NodeJS.ProcessEnv, cwd?: string, extraDenied?: string[]): string[];
export function assertAllServiceExecutions(): void;
export function consumeServiceExecDenials(dir: string): string;
export function testExecHelper(name: string, source: string, libraries?: string[]): string;
