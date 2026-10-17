import fs from 'node:fs';
import path from 'node:path';
import { RELEASE_CHANNELS, type ReleaseChannel } from '@myco/constants/update.js';

/** Shape of the install marker written to `<myco-home>/install.json`. */
export interface InstallMarker {
  channel: ReleaseChannel;
  source: 'curl' | 'npm';
  bin: string;
  /** Whether the build installed is a prerelease, as the installer found it; absent from older markers. */
  prerelease?: boolean;
}

/** Read the install marker; strict callers refuse damaged or inaccessible authority. */
export function readInstallMarker(dir: string, strict = false): InstallMarker | null {
  const markerPath = path.join(dir, 'install.json');
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as InstallMarker;
    if (strict && (!marker || !RELEASE_CHANNELS.includes(marker.channel) ||
      !['curl', 'npm'].includes(marker.source) || typeof marker.bin !== 'string' || !path.isAbsolute(marker.bin))) {
      throw new Error(`Invalid install marker at ${markerPath}; reinstall to record the channel and binary destination.`);
    }
    return marker;
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}
