export function infrastructureFaultSignature(text: string): string | null;
export function failureStackInFile(text: string, file: string): boolean;

export interface InfrastructureFailure { file?: string; body?: string }
export interface InfrastructureRetry { file: string; signature: string }
export function retryableInfrastructureFaults(input: { failures: InfrastructureFailure[] }): InfrastructureRetry[];

export function logHasUncarriedError(log: string): boolean;
export function infrastructureRetrySummary(file: string, signature: string): string;
export function replaceFileSuites(xml: string, file: string, rerunXml: string): string;
