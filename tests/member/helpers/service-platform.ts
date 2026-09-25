/**
 * A service platform that records every command and answers the status probes
 * from what it was told, the way launchd and systemd do: `load`/`enable` hold a
 * unit, `load`/`restart` start its process, `unload`/`remove`/`disable` let go
 * of both. A unit named in `dies` is held and never stays running.
 */
import path from 'node:path';
import type { CommandResult, ServiceRunner } from '@myco/server/service.js';

export interface RecordingPlatform {
  runner: ServiceRunner;
  commands: string[];
  loaded: Set<string>;
  running: Set<string>;
  dies: Set<string>;
}

export function recordingPlatform(): RecordingPlatform {
  const commands: string[] = [];
  const loaded = new Set<string>();
  const running = new Set<string>();
  const dies = new Set<string>();
  const nameOf = (arg: string): string => path.basename(arg).replace(/\.(plist|service)$/, '');
  const start = (name: string): void => { if (!dies.has(name)) running.add(name); };
  const drop = (name: string): void => { loaded.delete(name); running.delete(name); };
  const runner: ServiceRunner = (command, args): CommandResult => {
    const line = [command, ...args].join(' ');
    commands.push(line);
    const name = nameOf(args.at(-1) ?? '');
    if (line.startsWith('launchctl load')) { loaded.add(name); start(name); }
    else if (line.startsWith('launchctl unload') || line.startsWith('launchctl remove')) drop(name);
    else if (line.startsWith('launchctl list')) {
      return loaded.has(name) ? { status: 0, stdout: running.has(name) ? `{\n\t"PID" = 4242;\n\t"Label" = "${name}";\n};` : `{\n\t"Label" = "${name}";\n};` } : { status: 113 };
    } else if (line.startsWith('systemctl --user enable')) loaded.add(name);
    else if (line.startsWith('systemctl --user restart')) start(name);
    else if (line.startsWith('systemctl --user disable')) drop(name);
    else if (line.startsWith('systemctl --user is-enabled')) return { status: loaded.has(name) ? 0 : 1 };
    else if (line.startsWith('systemctl --user is-active')) return { status: running.has(name) ? 0 : 3 };
    else if (line.startsWith('schtasks /Create')) loaded.add(args[args.indexOf('/TN') + 1]!);
    else if (line.startsWith('schtasks /Run')) start(args[args.indexOf('/TN') + 1]!);
    else if (line.startsWith('schtasks /Delete')) drop(args[args.indexOf('/TN') + 1]!);
    else if (line.startsWith('schtasks /Query')) return { status: loaded.has(args[args.indexOf('/TN') + 1]!) ? 0 : 1 };
    else if (line.startsWith('powershell.exe')) {
      const task = /-TaskName '([^']+)'/.exec(line)?.[1] ?? '';
      return { status: 0, stdout: running.has(task) ? 'Running\r\n' : 'Ready\r\n' };
    }
    return { status: 0 };
  };
  return { runner, commands, loaded, running, dies };
}
