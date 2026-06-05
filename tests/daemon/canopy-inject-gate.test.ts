import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { initDatabase, closeDatabase, getDatabase, SQLITE_DB_FILE } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { MycoConfigSchema } from '@myco/config/schema';
import { createCanopyInjectHandler } from '@myco/daemon/api/canopy-inject';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { assertGroveProjectId } from '@myco/grove/ids';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import { _resetPendingInjections } from '@myco/canopy/inject/pending';

let tmpVault: string;
let tmpProjectId: string;

function ctx(overrides: Partial<MycoRequestContext> = {}): MycoRequestContext {
  return {
    projectRoot: tmpVault,
    callerRoot: null,
    projectId: assertGroveProjectId(tmpProjectId),
    groveId: 'grove_00000000000000000000000000000000',
    machineId: 'local',
    sessionId: null,
    projectVaultDir: path.join(tmpVault, '.myco'),
    databasePath: path.join(tmpVault, '.myco', SQLITE_DB_FILE),
    source: 'explicit',
    tenancySource: 'caller',
    ...overrides,
  };
}

beforeEach(() => {
  closeDatabase();
  _resetPendingInjections();
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-inject-gate-'));
  fs.mkdirSync(path.join(tmpVault, '.myco'), { recursive: true });
  const manifest = ensureProjectManifest(path.join(tmpVault, '.myco'), { projectName: 'canopy-inject-gate' });
  tmpProjectId = manifest.project.id;
  initDatabase(path.join(tmpVault, '.myco', SQLITE_DB_FILE));
  createSchema(getDatabase(), 'local');
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpVault, { recursive: true, force: true });
});

describe('POST /canopy/inject — per-project capability gate', () => {
  it('returns inject:false reason capability_off when project cortex.canopy.enabled is false, even if bootstrap config has canopy on', async () => {
    // Write per-project config with canopy disabled
    fs.writeFileSync(
      path.join(tmpVault, '.myco', 'myco.yaml'),
      'version: 3\ncortex:\n  canopy:\n    enabled: false\n',
    );

    // Bootstrap config has canopy enabled — proves the handler reads per-project, not bootstrap
    const bootstrapConfig = MycoConfigSchema.parse({ version: 3 });
    bootstrapConfig.cortex.canopy.enabled = true;

    const handler = createCanopyInjectHandler({
      liveConfig: { current: bootstrapConfig },
      getDatabase,
    });

    const res = await handler({
      requestContext: ctx(),
      body: {
        sessionId: 's1',
        agent: 'claude-code',
        toolInput: { file_path: 'src/index.ts' },
      },
    });

    expect(res.body).toMatchObject({ inject: false, reason: 'capability_off' });
  });
});
