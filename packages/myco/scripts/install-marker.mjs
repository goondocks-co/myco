import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

/** Publish the install marker through the caller's atomic file primitive. */
export function writeInstallMarker(home, marker, publish = atomicText) {
  fs.mkdirSync(home, { recursive: true });
  publish(path.join(home, 'install.json'), JSON.stringify(marker, null, 2));
}
