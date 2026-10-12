import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';

/** A held Compose bundle is observed without moving or rewriting it. */
export function retiredComposeBundle(mycoHome = resolveMycoHome()): string | null {
  return [path.join(mycoHome, 'server', 'compose', 'compose.yaml'), path.join(mycoHome, 'server', 'compose.yaml')]
    .find(file => existsSync(file)) ?? null;
}

export function composeRetiredMessage(bundle: string | null): string {
  return `The Compose target is retired${bundle === null ? '' : `: bundle held at ${bundle}`}. Keep its data. Use --target local to select an existing native Deployment, or run myco server create --target local to create one. You can also run the plain server image.`;
}
