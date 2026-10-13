import path from 'node:path';
import { resolveMycoHome } from './home.js';

/** The resolved home is the ownership identity recorded in subsystem claims. */
export function daemonIdentity(mycoHome: string = resolveMycoHome()): string {
  return path.resolve(mycoHome);
}
