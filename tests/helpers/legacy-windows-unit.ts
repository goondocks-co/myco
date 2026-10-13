import fs from 'node:fs';
import path from 'node:path';
import type { SchtasksRunner, TaskSchedulerState } from '@myco/member/legacy-service/windows.js';

export function legacyWindowsUnit(dir: string, home: string, label = 'co.goondocks.myco.legacy') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label}.ps1`);
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const script = fs.readFileSync(new URL('../fixtures/legacy/daemon-launcher.ps1', import.meta.url), 'utf8')
    .replaceAll('__MYCO_HOME__', home.replaceAll("'", "''"));
  fs.writeFileSync(file, script);
  const calls: string[][] = [];
  let state: TaskSchedulerState = 'running';
  const command = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(`& ${literal(file)}`, 'utf16le').toString('base64');
  const sid = 'S-1-5-21-fixture';
  const xml = `<Task><Settings><Enabled>true</Enabled></Settings><Principals><Principal><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals><Actions><Exec><Command>${command}</Command><Arguments>-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}</Arguments></Exec></Actions></Task>`;
  const runner: SchtasksRunner = {
    queryState: async () => state,
    currentUserSid: async () => sid,
    run: async args => {
      calls.push(args);
      if (args[0] === '/query') return { stdout: state === 'disabled' ? xml.replace('<Enabled>true</Enabled>', '<Enabled>false</Enabled>') : xml, exitCode: 0 };
      if (args[0] === '/change') state = 'disabled';
      if (args[0] === '/delete') state = 'absent';
      return { stdout: '', exitCode: 0 };
    },
  };
  return { file, script, label, calls, runner, xml, exit: () => { state = 'disabled'; } };
}
