import { afterEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDeployment, openDeploymentRequests } from '@myco/cli/deployment-reader.js';
import { readRegistryEntry, REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

for (const scope of ['project', 'deployment'] as const) for (const response of ['ok', 'unauthorized', 'unreachable'] as const) {
  it(`observes ${scope} without credential renewal or local writes (${response})`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-observation-'));
    roots.push(root);
    const mycoHome = path.join(root, 'myco');
    const serverUrl = 'https://observe.invalid';
    const token = 'a'.repeat(43);
    writeRegistryEntry({ version: REGISTRY_VERSION, root, projectId: 'proj_observe', serverUrl, token,
      machineId: 'machine_observe', joinedAt: 1, updatedAt: 1, expiresAt: 500, refreshAfter: 400 }, { mycoHome });
    const snapshot = (): Record<string, string> => {
      const files = fs.readdirSync(mycoHome, { recursive: true, withFileTypes: true });
      return Object.fromEntries(files.filter((file) => file.isFile()).map((file) => {
        const name = path.join(file.parentPath, file.name);
        return [name, fs.readFileSync(name, 'utf8')];
      }));
    };
    const before = snapshot();
    const requests: string[] = [];
    const deps = { cwd: root, mycoHome, renew: false, now: () => 1000, env: { MYCO_TEMPORARY_FOLDERS: process.env.MYCO_TEMPORARY_FOLDERS }, fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(new URL(request.url).pathname);
      expect(request.headers.get('authorization')).toBe(`Bearer ${token}`);
      if (response === 'unreachable') throw new Error('fixture offline');
      return response === 'unauthorized' ? Response.json({ error: 'unauthorized' }, { status: 401 }) : Response.json({ persisted: true });
    } };
    const opened = scope === 'project' ? await openDeployment('registry', deps) : await openDeploymentRequests('registry', deps, serverUrl);
    const handle = scope === 'project' ? opened : opened !== null && 'ok' in opened && opened.ok ? opened.value : null;
    expect(handle).not.toBeNull();
    if (handle === null || !('post' in handle)) throw new Error('observation did not open');
    const answer = await handle.post('/members/status', {});
    expect(answer.ok).toBe(response === 'ok');
    if (!answer.ok) expect(answer.error.code).toBe(response);
    expect(requests).toEqual(['/members/status']);
    expect(snapshot()).toEqual(before);
    expect(readRegistryEntry(root, mycoHome)?.token).toBe(token);
  });
}
