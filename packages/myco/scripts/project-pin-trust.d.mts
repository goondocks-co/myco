export function readApprovedProjectPin(filePath: string, homeDir?: string): string | null;
export function projectPinIsTrusted(filePath: string, homeDir?: string): boolean;
export function trustProjectPin(filePath: string, homeDir?: string, ownerHome?: string): void;
export function preflightProjectPinWrite(filePath: string, homeDir?: string): void;
export function writeTrustedProjectPin(filePath: string, value: string, options?: { homeDir?: string; ownerHome?: string; replace?: boolean }): void;
export function projectPinTrustFiles(ownerHome: string, homeDir?: string): string[];
export function removeProjectPinTrust(ownerHome: string, homeDir?: string): void;
