/**
 * Every harness a worker can drive, paired with the driver that drives it.
 *
 * The registry is derived from the harness manifest rather than listed again:
 * a harness whose launch shape says it speaks the protocol gets the protocol
 * driver, and the two with native drivers name them. So a harness added to the
 * manifest is drivable, or fails a gate that enumerates from the manifest —
 * never silently absent.
 */
import type { Driver } from '../events.js';
import { HARNESSES } from '../harnesses.js';
import { acpDriver } from './acp.js';
import { claudeCodeDriver } from './claude-code.js';
import { codexDriver } from './codex.js';

/** The drivers written against a harness's own stream rather than the agent protocol. */
const NATIVE: Readonly<Record<string, Driver>> = {
  'claude-code': claudeCodeDriver,
  codex: codexDriver,
};

export const DRIVERS: Readonly<Record<string, Driver>> = Object.fromEntries(
  HARNESSES.map((harness) => [harness.id, NATIVE[harness.id] ?? acpDriver(harness.id)]),
);

/** The driver for this harness, or null when the worker drives none by that name. */
export function driverFor(id: string): Driver | null {
  return DRIVERS[id] ?? null;
}
