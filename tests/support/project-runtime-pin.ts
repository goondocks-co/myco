import fs from 'node:fs';
import path from 'node:path';
import { trustProjectPin } from '@myco/paths/pin-trust.js';

/** A project pin explicitly approved by the fixture's user before its final mode is applied. */
export function writeApprovedProjectPin(
  root: string,
  name: 'runtime.home' | 'runtime.command',
  value: string,
  options: { userHome?: string; mode?: number } = {},
): string {
  const userHome = options.userHome ?? process.env.HOME;
  if (!userHome) throw new Error('an approved project pin fixture requires its user home');
  const pin = path.join(root, '.myco', name);
  fs.mkdirSync(path.dirname(pin), { recursive: true });
  fs.writeFileSync(pin, value, { mode: 0o600 });
  fs.chmodSync(pin, 0o600);
  trustProjectPin(pin, userHome);
  fs.chmodSync(pin, options.mode ?? 0o600);
  return pin;
}
