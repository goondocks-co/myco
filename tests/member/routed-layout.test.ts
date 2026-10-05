import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { MemberSpool } from '@myco/member/spool.js';
import { legacySpoolDir, listLegacySpools } from '@myco/member/spool-migration.js';
import { listSpoolDestinations, routedSpoolDir } from '@myco/member/routing.js';
import { behindTranscriptPaths } from '@myco/member/retention.js';
import { updateSessionState } from '@myco/member/session-state.js';
import { transcriptPointerFor } from '@myco/member/transcript.js';
import { deploymentKeyFor } from '@myco/member/registry.js';
import { tempMycoHome } from './helpers/server.js';

describe('routed spool namespace', () => {
  it('keeps a sixteen-hex legacy Project distinct from a Deployment namespace', () => {
    const mycoHome = tempMycoHome();
    const serverUrl = 'https://layout.invalid';
    const projectId = deploymentKeyFor(serverUrl);
    const route = { serverUrl, projectId };
    const legacy = new MemberSpool(null, { dir: legacySpoolDir(projectId, mycoHome), mycoHome });
    const routed = new MemberSpool(route, { mycoHome });
    expect(routed.dir).toBe(path.join(mycoHome, 'member', 'spool', `d-${projectId}`, projectId));
    expect(routedSpoolDir(route, mycoHome)).not.toBe(legacy.dir);
    expect(listSpoolDestinations(mycoHome)).toEqual([route]);
    expect(listLegacySpools(mycoHome).map((entry) => entry.projectId)).toEqual([projectId]);
    const file = path.join(mycoHome, 'transcript.jsonl');
    fs.writeFileSync(file, '{"fixture":true}\n');
    for (const spool of [legacy, routed]) {
      updateSessionState(spool.dir, 'same-session', (state) => {
        const pointer = transcriptPointerFor(file, 'claude-code');
        if (pointer === null) throw new Error('Fixture transcript is unavailable');
        state.transcript = pointer;
      });
    }
    expect(behindTranscriptPaths(mycoHome)).toEqual(new Set([file]));
  });
});
