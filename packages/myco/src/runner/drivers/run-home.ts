/**
 * A configuration directory of the run's own, for a harness pointed at one by
 * a variable.
 *
 * The directory is inside the run's own and goes when the run does, so what
 * the harness writes beside its configuration (sessions, history, logs) is the
 * run's and never the machine's. It is built from nothing on every attempt: a
 * worker killed mid-run leaves a home behind, and the run it belongs to is
 * claimed again under the same id. Only the worker's user can read it.
 *
 * What goes into the directory is each harness's own: which of the machine's
 * settings are carried, how its login reaches the run, and which settings are
 * the run's rather than the machine's.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** An empty directory named `name` inside the run's directory, replacing whatever an earlier attempt left there. */
export function freshRunHome(scratchDir: string, name: string): string {
  const home = join(scratchDir, name);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}
