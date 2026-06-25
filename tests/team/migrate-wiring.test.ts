import { describe, expect, it, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxMycoHome } from '../helpers/myco-home-sandbox.js';
import { migrateTeamsHomeIfNeeded } from '@myco/team/migrate-home.js';

describe('startup migration is loss-safe and non-throwing', () => {
  let sb: ReturnType<typeof sandboxMycoHome>;
  afterEach(() => sb?.restore());
  it('relocates a legacy MYCO_HOME team into the team home and never throws', () => {
    sb = sandboxMycoHome();
    const teamId = 'team_' + 'd'.repeat(32);
    const legacy = path.join(sb.mycoHome, 'teams', teamId);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'team.json'), JSON.stringify({ team_id: teamId, name: 'L' }), 'utf-8');
    expect(() => migrateTeamsHomeIfNeeded([sb.mycoHome])).not.toThrow();
    expect(fs.existsSync(path.join(process.env.MYCO_TEAM_HOME!, 'teams', teamId, 'team.json'))).toBe(true);
  });
});
