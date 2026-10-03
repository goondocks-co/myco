/**
 * Cursor's configuration, as a run reads it.
 *
 * Cursor asks the client before a call only where its own configuration has
 * not approved it in advance: an entry in `permissions.allow` of its
 * `cli-config.json`, an entry in the `permissions.json` beside it, or
 * `approvalMode: "unrestricted"` (Run Everything), under which nothing asks.
 * `autoAcceptWebSearch` approves every web search the same way. Each of these
 * is the machine's user deciding for themselves, and none of them may decide a
 * run's calls, which the run's grant answers.
 *
 * So a run reads a configuration directory of its own. The machine's settings
 * are carried into it with those four pinned: nothing approved in advance, and
 * the allowlist mode that asks for the rest. The machine's deny list is kept,
 * since a denial only narrows what a run can do. The login is not carried and
 * need not be: Cursor keeps it in the platform keychain, or in a file under
 * the user's home, and neither is inside the configuration directory.
 *
 * A configuration directory with no `cli-config.json` is not an empty one to
 * Cursor: it writes its default, and that default allows `ls`. So the file is
 * always written.
 */
import nodeFs from 'node:fs';
const { existsSync, readFileSync, writeFileSync } = nodeFs;
import { homedir } from 'node:os';
import { join } from 'node:path';
import { recordOf } from './stream.js';

/** The file Cursor reads its settings and permissions from, inside its configuration directory. */
export const CURSOR_CONFIG_FILE = 'cli-config.json';

/** The settings a run's configuration holds whatever the machine's holds. */
export const CURSOR_RUN_SETTINGS = { approvalMode: 'allowlist', autoAcceptWebSearch: false } as const;

/** The machine's own files carried into a run's configuration directory unchanged: the model variant its ACP server selects. */
const CARRIED_FILES: readonly string[] = ['acp-config.json'];

/** The directory Cursor reads its configuration from on this machine, resolved as Cursor resolves it. */
export function machineCursorConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.CURSOR_CONFIG_DIR?.trim();
  if (named !== undefined && named !== '') return named;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return xdg !== undefined && xdg !== '' ? join(xdg, 'cursor') : join(homedir(), '.cursor');
}

/** The machine's settings, or none where it has no readable settings file. */
function machineSettings(dir: string): Record<string, unknown> {
  const at = join(dir, CURSOR_CONFIG_FILE);
  if (!existsSync(at)) return {};
  try { return recordOf(JSON.parse(readFileSync(at, 'utf8'))) ?? {}; } catch { return {}; }
}

/** Write a run's Cursor configuration into `home`, a directory of the run's own. */
export function writeCursorRunHome(home: string, machineDir: string = machineCursorConfigDir()): void {
  const machine = machineSettings(machineDir);
  const permissions = recordOf(machine.permissions);
  const deny = Array.isArray(permissions?.deny) ? permissions.deny.filter((entry) => typeof entry === 'string') : [];
  const settings = { ...machine, permissions: { allow: [], deny }, ...CURSOR_RUN_SETTINGS };
  writeFileSync(join(home, CURSOR_CONFIG_FILE), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  for (const name of CARRIED_FILES) {
    const at = join(machineDir, name);
    if (existsSync(at)) writeFileSync(join(home, name), readFileSync(at), { mode: 0o600 });
  }
}
