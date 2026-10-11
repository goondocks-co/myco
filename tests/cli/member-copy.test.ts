import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
const { readFileSync, mkdtempSync } = fs;
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMBER_HELP } from '@myco/cli/member.js';
import { LOGIN_HELP } from '@myco/cli/login.js';
import { run as runConfig } from '@myco/cli/member-config.js';
import { IDENTITY_LINK_TTL_MS } from '@myco-server-worker/auth/identity-link.js';
import { MACHINE_SETTINGS_CONTROLS, machineSettingsLocation } from '@goondocks/myco-shared/setup-guidance';
import { registerTestMember } from '../member/helpers/hooks.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

const source = (file: string): string => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

describe('member recovery copy', () => {
  it('uses the identity link lifetime and requires a project-bound sandbox invitation', () => {
    expect(MEMBER_HELP).toContain(`within ${IDENTITY_LINK_TTL_MS / 60_000} minutes`);
    expect(MEMBER_HELP).not.toContain('ten minutes');
    expect(LOGIN_HELP).toContain('project-bound invitation');
    expect(LOGIN_HELP).not.toContain('same link');
  });

  it('points config users to the machine settings controls the dashboard currently serves', async () => {
    const root = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-copy-')));
    registerTestMember({ mycoHome: root, root, serverUrl: 'https://member-test.invalid', token: 'm'.repeat(43), projectId: 'proj_copy' });
    const err: string[] = [];
    expect(await runConfig(['set', 'capture.plan_dirs', '[]'], 'registry', {
      mycoHome: root, cwd: root, renew: false, stderr: (line) => err.push(line),
    })).toBe(false);
    expect(err.join('\n')).toContain(machineSettingsLocation('https://member-test.invalid'));
    const nav = source('packages/myco-server/ui/src/routes/nav.ts');
    expect(nav).toContain(`MY_MACHINES_PATH = '${MACHINE_SETTINGS_CONTROLS.path}'`);
    expect(nav).toContain(`[MY_MACHINES_PATH]: '${MACHINE_SETTINGS_CONTROLS.page}'`);
    expect(source('packages/myco-server/ui/src/features/admin/people/MachineList.tsx')).toContain(`label: '${MACHINE_SETTINGS_CONTROLS.action}'`);
  });
});
