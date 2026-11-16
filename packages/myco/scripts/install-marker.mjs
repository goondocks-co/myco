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
  writeUpdatePreferences(home, { automaticUpdates: enabled }, publish);
}

/** Merge installation preferences without replacing a sibling preference. */
export function writeUpdatePreferences(home, patch, publish = atomicText) {
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(path.join(home, AUTOMATIC_UPDATE_PREFERENCE_FILE), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && (patch.machineUpdate !== undefined || !(error instanceof SyntaxError))) throw error; }
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    if (patch.machineUpdate !== undefined) throw new Error('Invalid installation update preferences');
    previous = {};
  }
  const { machineUpdate, changedAt, ...preferences } = patch;
  const machineRequests = machineUpdate === undefined ? previous.machineRequests : {
    ...previous.machineRequests,
    [machineUpdate.deployment]: { ...previous.machineRequests?.[machineUpdate.deployment], ...machineUpdate.requests },
  };
  publishInstallFile(home, AUTOMATIC_UPDATE_PREFERENCE_FILE, { ...previous, ...preferences, ...(changedAt === undefined ? {} : { changedAt: { ...previous.changedAt, ...changedAt } }), ...(machineRequests === undefined ? {} : { machineRequests }) }, publish);
}
