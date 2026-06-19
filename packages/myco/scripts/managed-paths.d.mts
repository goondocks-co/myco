// Types for the shared managed-path layout module (managed-paths.mjs).
// See that file for the convention: callers pass the resolved myco-home.

export function managedBinDir(
  mycoHome: string,
  platform: NodeJS.Platform | string,
  localAppData?: string,
): string;

export function managedBinaryPath(
  mycoHome: string,
  platform: NodeJS.Platform | string,
  localAppData?: string,
): string;

export function versionsDir(
  mycoHome: string,
  platform: NodeJS.Platform | string,
  localAppData?: string,
): string;

export function versionDir(
  mycoHome: string,
  platform: NodeJS.Platform | string,
  version: string,
  localAppData?: string,
): string;

export function versionBinaryPath(
  mycoHome: string,
  platform: NodeJS.Platform | string,
  version: string,
  localAppData?: string,
): string;
