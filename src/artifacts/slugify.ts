import crypto from 'node:crypto';
import path from 'node:path';

export function slugifyPath(relativePath: string): string {
  const ext = path.extname(relativePath);
  const withoutExt = ext ? relativePath.slice(0, -ext.length) : relativePath;

  let slug = withoutExt
    .replace(/[/\\]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  if (slug.length > 100) {
    const hash = crypto
      .createHash('sha256')
      .update(relativePath)
      .digest('hex')
      .slice(0, 6);
    slug = slug.slice(0, 100) + '-' + hash;
  }

  return slug;
}
