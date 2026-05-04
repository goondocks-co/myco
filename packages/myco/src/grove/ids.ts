import crypto from 'node:crypto';

const RANDOM_BYTES = 8;

export function createGroveId(): string {
  return `grove_${crypto.randomBytes(RANDOM_BYTES).toString('hex')}`;
}

export function createProjectId(): string {
  return `proj_${crypto.randomBytes(RANDOM_BYTES).toString('hex')}`;
}

export function createGroveBindingId(): string {
  return `gbind_${crypto.randomBytes(RANDOM_BYTES).toString('hex')}`;
}

export function slugifyGroveName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'default';
}
