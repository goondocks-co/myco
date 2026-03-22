import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILENAME } from '../../config/loader.js';

/** Compute config hash from the YAML file on disk. Cache this at startup and after saves. */
export function computeConfigHash(vaultDir: string): string {
  try {
    const configPath = path.join(vaultDir, CONFIG_FILENAME);
    const raw = fs.readFileSync(configPath, 'utf-8');
    return createHash('md5').update(raw).digest('hex');
  } catch {
    return '';
  }
}
