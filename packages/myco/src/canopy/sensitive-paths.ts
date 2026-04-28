import path from 'node:path';

const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.dockercfg',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

const SENSITIVE_EXTENSIONS = new Set([
  '.key',
  '.pem',
  '.p12',
  '.pfx',
]);

export function isCanopySensitivePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  const lower = basename.toLowerCase();
  if (SENSITIVE_BASENAMES.has(lower)) return true;
  if (lower.startsWith('.env.')) return true;
  if (lower.endsWith('_rsa') || lower.endsWith('_dsa') || lower.endsWith('_ecdsa') || lower.endsWith('_ed25519')) {
    return true;
  }
  return SENSITIVE_EXTENSIONS.has(path.extname(lower));
}
