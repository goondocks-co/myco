export function infrastructureFaultSignature(text: string): string | null;

export interface InfrastructureFailure { file?: string; message?: string }
export interface InfrastructureRetry { file: string; signature: string }
export function retryableInfrastructureFaults(input: {
  log: string;
  failures: InfrastructureFailure[];
  files: string[];
}): InfrastructureRetry[];

export function infrastructureRetrySummary(file: string, signature: string): string;
export function combineJunitReports(xmls: string[]): string;
