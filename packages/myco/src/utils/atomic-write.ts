import fs from 'node:fs';

/**
 * Write a file via temp+rename so readers either see the prior valid
 * contents or the new contents — never a torn write. Required for any
 * file that backs a recoverable on-disk state machine (registry,
 * markers, manifests).
 */
export function atomicWriteFileSync(
  filePath: string,
  contents: string | Buffer,
  encoding: BufferEncoding = 'utf-8',
): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  if (typeof contents === 'string') {
    fs.writeFileSync(tmp, contents, encoding);
  } else {
    fs.writeFileSync(tmp, contents);
  }
  fs.renameSync(tmp, filePath);
}
