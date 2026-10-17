import fs from 'node:fs';
import path from 'node:path';
import { RELEASE_CHANNELS, type ReleaseChannel } from '@myco/constants/update.js';
import { AUTOMATIC_UPDATE_PREFERENCE_FILE } from '../../scripts/install-marker.mjs';
import { validSourceInstallMarker } from '../../scripts/install-marker-schema.mjs';

/** Shape of the install marker written to `<myco-home>/install.json`. */
interface BaseInstallMarker {
  channel: ReleaseChannel;
  bin: string;
  /** Whether the build installed is a prerelease, as the installer found it; absent from older markers. */
  prerelease?: boolean;
}

export type InstallMarker = BaseInstallMarker & (
  { source: 'curl' | 'npm'; version?: string; binary_sha256?: string }
  | { source: 'checkout'; checkout: string; commit: string; version: string; binary_sha256: string }
);

/** Validate the authority recorded in an install marker without requiring the checkout to remain present. */
export function validInstallMarker(value: unknown): value is InstallMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  if (!RELEASE_CHANNELS.includes(marker.channel as ReleaseChannel) || typeof marker.bin !== 'string' || !path.isAbsolute(marker.bin)) return false;
  if (marker.source === 'curl' || marker.source === 'npm') return true;
  return validSourceInstallMarker(marker);
}

/** Missing or unreadable preferences keep automatic updates on. */
export function readAutomaticUpdatePreference(home: string): { enabled: boolean; error?: string } {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(home, AUTOMATIC_UPDATE_PREFERENCE_FILE), 'utf8'));
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)
      || (marker.automaticUpdates !== undefined && typeof marker.automaticUpdates !== 'boolean')) {
      throw new Error('automaticUpdates must be true or false');
    }
    return { enabled: marker.automaticUpdates ?? true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: true };
    return { enabled: true, error: error instanceof Error ? error.message : String(error) };
  }
}

export function automaticUpdatesEnabled(home: string): boolean {
  return readAutomaticUpdatePreference(home).enabled;
}

/** Read the install marker; strict callers refuse damaged or inaccessible authority. */
export function readInstallMarker(dir: string, strict = false): InstallMarker | null {
  const markerPath = path.join(dir, 'install.json');
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as InstallMarker;
    if (strict && !validInstallMarker(marker)) {
      throw new Error(`Invalid install marker at ${markerPath}; reinstall to record the channel and binary destination.`);
    }
    return marker;
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}
