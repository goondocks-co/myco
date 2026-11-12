import { afterEach, beforeEach, describe, expect, it } from 'bun:test'; import fs from 'node:fs'; import path from 'node:path'; import { legacyMigrationState, readCutoverState } from '@myco/member/legacy-migration.js'; import { openCutoverProjects, PROJECT, SERVER, sha, type CutoverProjects, type Machine } from './cutover-machine.js'; import { type MemberRig } from '../member/helpers/server.js';

describe('personal and work cutover destinations', () => {
  let m: Machine; let personal: MemberRig; let fetchBoth: MemberRig['fetch']; let projectsOn: CutoverProjects['projectsOn']; let HOMELAB: string; let PERSONAL: string; let release: () => void;
  beforeEach(async () => { ({ m, personal, fetchBoth, projectsOn, HOMELAB, PERSONAL, release } = await openCutoverProjects()); });
  afterEach(() => release());

  it('previews first, then places homelab only on personal and every other project only on work', async () => {
    const requests: string[] = [];
    const fetch: MemberRig['fetch'] = (input, init) => { requests.push(new URL(new Request(input, init).url).pathname); return fetchBoth(input, init); };
    const before = sha(m.vault);
    const dry = await m.run(['--dry-run'], { fetch, agents: [] });
    expect(dry.ok).toBe(true); expect(requests.every(route => route === '/import/legacy-history')).toBe(true); expect(sha(m.vault)).toBe(before);
    expect(dry.out.join('\n')).toContain(`${HOMELAB} from ${m.vault}: to ${PERSONAL}`);
    expect(dry.out.join('\n')).toContain(`${PROJECT} from ${m.vault}: to ${SERVER}`);
    expect(fs.existsSync(path.join(m.mycoHome, 'member', 'cutover.json'))).toBe(false);
    const result = await m.run([], { fetch, agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true);
    for (const table of ['sessions', 'spores', 'events']) {
      expect(projectsOn(personal, table)).toEqual([{ project_id: HOMELAB }]);
      expect(projectsOn(m.rig, table)).toEqual([{ project_id: PROJECT }]);
    }
    expect(legacyMigrationState(m.mycoHome).state).toBe('moved');
    const state = readCutoverState(m.mycoHome);
    expect(state.version).toBe(2);
    expect(state.migrations![m.vault].projects[HOMELAB].destination).toMatchObject({ serverUrl: PERSONAL });
    expect(state.migrations![m.vault].projects[PROJECT].destination).toMatchObject({ serverUrl: SERVER });
    expect(sha(m.vault)).toBe(before);
  });

  it('refuses to route a bound personal repository to the work default', async () => {
    const result = await m.run(['--route', `${HOMELAB}=${SERVER}`], { fetch: fetchBoth, agents: [] });
    expect(result.ok).toBe(false); expect(result.err.join('\n')).toContain(`routes to ${PERSONAL}`);
    expect(personal.rows('events')).toBe(0); expect(m.rig.rows('events')).toBe(0);
  });
});
