import crypto from 'node:crypto';
import path from 'node:path';
import { MAX_SLUG_LENGTH } from '../constants.js';

export function slugifyPath(relativePath: string): string {
  const ext = path.extname(relativePath);
  const withoutExt = ext ? relativePath.slice(0, -ext.length) : relativePath;

  let slug = withoutExt
    .replace(/[/\\]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  if (slug.length > MAX_SLUG_LENGTH) {
    const hash = crypto
      .createHash('sha256')
      .update(relativePath)
      .digest('hex')
      .slice(0, 6);
    slug = slug.slice(0, MAX_SLUG_LENGTH) + '-' + hash;
  }

  return slug;
}
