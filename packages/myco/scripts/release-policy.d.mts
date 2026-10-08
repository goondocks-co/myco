import type { ReleaseChannel } from '../src/constants/update.js';
import type { GitHubRelease } from '../src/upgrade/release-assets.js';
export const RELEASE_POLICY: {
  versionPattern: string;
  developmentPattern: string;
  phases: Record<string, number>;
  channels: Record<ReleaseChannel, readonly string[]>;
  order: readonly string[];
  minimumMajor: number;
  rejectDrafts: boolean;
  rejectFlaggedStable: boolean;
  requireCompleteAssets: boolean;
  neverDowngrade: boolean;
  maximumComponent: number;
};
export function releaseKey(version: string): { phase: string; key: number[] } | null;
export function compareReleaseVersions(a: string, b: string): number;
export function selectChannelRelease<T extends GitHubRelease>(releases: T[], channel: ReleaseChannel, options?: {
  asset?: string;
  currentVersion?: string;
  minimumMajor?: number;
  maximumMajor?: number;
}): T | null;
export function renderReleaseSelector(): string;

export function isDevelopmentVersion(version: string): boolean;
export function isV2Version(version: string): boolean;
