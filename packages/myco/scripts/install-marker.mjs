import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const AUTOMATIC_UPDATE_PREFERENCE_FILE = 'install-update.json';

function atomicText(file, text) {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function publishInstallFile(home, filename, value, publish) {
  fs.mkdirSync(home, { recursive: true });
  publish(path.join(home, filename), JSON.stringify(value, null, 2));
}

/** Publish the install marker through the caller's atomic file primitive. */
export function writeInstallMarker(home, marker, publish = atomicText) {
  publishInstallFile(home, 'install.json', marker, publish);
}

/** Installation update preferences survive replacement of the release marker. */
export function writeAutomaticUpdatePreference(home, enabled, publish = atomicText) {
  publishInstallFile(home, AUTOMATIC_UPDATE_PREFERENCE_FILE, { automaticUpdates: enabled }, publish);
}
