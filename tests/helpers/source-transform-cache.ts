import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** A run-owned cache retains exact transformed source under its complete input identity. */
export function sourceTransformCache(directory: string, dependencies: readonly string[]) {
  fs.mkdirSync(directory, { recursive: true });
  const epoch = digest(JSON.stringify(dependencies));
  return (file: string, source: string, transform: () => string): string => {
    const key = digest(JSON.stringify([epoch, file, source]));
    const entry = path.join(directory, key + '.json');
    if (fs.existsSync(entry)) {
      const held: { key: string; sha256: string; contents: string } = JSON.parse(fs.readFileSync(entry, 'utf8'));
      if (held.key !== key || typeof held.contents !== 'string' || digest(held.contents) !== held.sha256)
        throw new Error('Invalid source transform cache entry');
      return held.contents;
    }
    const contents = transform();
    const temporary = entry + '.' + process.pid + '.' + randomUUID();
    fs.writeFileSync(temporary, JSON.stringify({ key, sha256: digest(contents), contents }), { flag: 'wx' });
    fs.renameSync(temporary, entry);
    return contents;
  };
}
