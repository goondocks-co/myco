import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_RUNTIME_COMMAND_FILENAME } from '../constants/update.js';

export function readProjectRuntimeCommand(vaultDir: string): string | null {
  try {
    const value = fs.readFileSync(path.join(vaultDir, PROJECT_RUNTIME_COMMAND_FILENAME), 'utf-8').trim();
    return value || null;
  } catch {
    return null;
  }
}
