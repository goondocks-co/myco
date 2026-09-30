/**
 * Meta gate: a machine whose credential the Deployment will no longer renew is
 * told one act, in one text (#1382). `REJOIN_HINT` in
 * `@goondocks/myco-shared/member-protocol` names the dashboard controls that
 * make an invitation for the machine's existing member, and the dashboard
 * renders those controls from the same constant.
 *
 *   1. No other source words the remedy on its own: a phrasing of it anywhere
 *      but the constant fails, in the member, the server and the dashboard.
 *   2. The remedy quotes the controls the dashboard renders, and the dashboard
 *      renders them from the constant, never from a literal of its own.
 *   3. Every kind of notice the member gives about an ended credential ends in
 *      the remedy.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVITE_CONTROLS, REJOIN_FOR_ADMIN, REJOIN_HINT } from '@goondocks/myco-shared/member-protocol';
import { deliveryNotice } from '@myco/member/delivery-notice.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const RULE = 'packages/myco-shared/src/member-protocol.ts';
const TREES = ['packages/myco/src', 'packages/myco-server/src', 'packages/myco-server/ui/src'];
const PEOPLE_PAGE = 'packages/myco-server/ui/src/features/admin/people/PeoplePage.tsx';
/** The dialog that makes the invitation, whose controls the remedy names. */
const INVITE_DIALOG = 'packages/myco-server/ui/src/features/admin/people/InviteDialog.tsx';
/** Where the page states the remedy to an admin who stops a machine. */
const MACHINES_LIST = 'packages/myco-server/ui/src/features/admin/people/MachineList.tsx';

/** Ways to word the remedy that belong to the constant alone. */
const REMEDY_WORDING = [
  /\bsigns? (this machine |it )?in again\b/i,
  new RegExp(`${INVITE_CONTROLS.button}\\s*→\\s*${INVITE_CONTROLS.field}`, 'i'),
  /invitation for (your|its|their) (existing )?member/i,
  /for an invite link and run/i,
];

const allFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const f = join(dir, e);
    return statSync(f).isDirectory() ? allFiles(f) : [f];
  });

describe('the rejoin remedy', () => {
  it('is worded in the one constant and nowhere else', () => {
    const offenders: string[] = [];
    for (const tree of TREES) {
      for (const file of allFiles(join(REPO, tree)).filter((f) => /\.tsx?$/.test(f) && !f.includes('.generated.'))) {
        const rel = relative(REPO, file);
        const text = readFileSync(file, 'utf8');
        text.split('\n').forEach((line, n) => {
          if (REMEDY_WORDING.some((p) => p.test(line))) offenders.push(`${rel}:${n + 1}: ${line.trim().slice(0, 120)}`);
        });
      }
    }
    expect(offenders).toEqual([]);
    expect(REMEDY_WORDING.some((p) => p.test(readFileSync(join(REPO, RULE), 'utf8')))).toBe(true);
  });

  it('quotes the dashboard controls, which the dashboard renders from the same constant', () => {
    for (const control of [INVITE_CONTROLS.page, INVITE_CONTROLS.button, INVITE_CONTROLS.field]) expect(REJOIN_HINT).toContain(control);
    for (const control of [INVITE_CONTROLS.button, INVITE_CONTROLS.field]) expect(REJOIN_FOR_ADMIN).toContain(control);
    expect(readFileSync(join(REPO, MACHINES_LIST), 'utf8')).toContain('${REJOIN_FOR_ADMIN}');
    const source = [PEOPLE_PAGE, INVITE_DIALOG].map((file) => readFileSync(join(REPO, file), 'utf8')).join('\n');
    for (const name of ['page', 'invite', 'button', 'field']) expect({ name, used: source.includes(`INVITE_CONTROLS.${name}`) }).toEqual({ name, used: true });
    // Each control's words come from the constant alone: none is written out as a literal beside it.
    for (const words of Object.values(INVITE_CONTROLS)) {
      for (const literal of [`'${words}'`, `"${words}"`, `>${words}<`]) expect({ literal, present: source.includes(literal) }).toEqual({ literal, present: false });
    }
  });

  it('ends every notice about an ended credential', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    const base = { serverUrl: 'https://myco.example' };
    const notices = [
      deliveryNotice({ ...base, nonRotating: true, expiresAt: now - 1 }, now),
      deliveryNotice({ ...base, refreshTerminal: true, refreshTerminalReason: 'replayed' }, now),
      deliveryNotice({ ...base, refreshTerminal: true, expiresAt: now + 1_000 }, now),
      deliveryNotice({ ...base, refreshTerminal: true, expiresAt: now - 1_000 }, now),
    ];
    for (const notice of notices) expect(notice).toContain(REJOIN_HINT);
  });
});
