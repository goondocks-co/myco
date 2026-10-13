import fs from 'node:fs';
import path from 'node:path';
import { renderWindowsServiceScript } from '@myco/member/legacy-service/windows-task.js';
import type { SchtasksRunner, TaskSchedulerState } from '@myco/member/legacy-service/windows.js';

export function legacyWindowsUnit(dir: string, home: string, label = 'co.goondocks.myco.legacy') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label}.ps1`);
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const script = '\uFEFF' + renderWindowsServiceScript({
    label, variant: 'prod', executable: 'C:\\Myco\\myco.exe', args: ['daemon'],
    workingDir: home, env: { MYCO_HOME: home }, stdoutPath: path.join(home, 'out.log'),
    stderrPath: path.join(home, 'err.log'), runAtLoad: true, keepAlive: true, throttleSeconds: 10,
  });
  fs.writeFileSync(file, script);
  const calls: string[][] = [];
  let state: TaskSchedulerState = 'running';
  const command = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(`& ${literal(file)}`, 'utf16le').toString('base64');
  const sid = 'S-1-5-21-fixture';
  const xml = `<Task><Settings><Enabled>true</Enabled></Settings><Principals><Principal><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals><Actions><Exec><Command>${command}</Command><Arguments>-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}</Arguments></Exec></Actions></Task>`;
  const unexpected = async (): Promise<never> => { throw new Error('unexpected Task Scheduler operation'); };
  const runner: SchtasksRunner = {
    queryState: async () => state,
    currentUserSid: async () => sid,
    register: unexpected,
    endProcessTree: unexpected,
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
