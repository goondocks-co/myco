import { describe, it, expect } from 'bun:test';
import {
  ActionScopeSchema,
  resolveActionScope,
  actionScopeKey,
  InvalidActionScopeError,
} from '@myco/daemon/api/action-scope';
import { assertGroveProjectId } from '@myco/grove/ids';

const VALID_PROJECT_ID = 'proj_' + 'a'.repeat(32);
const VALID_GROVE_ID = 'grove_' + 'b'.repeat(32);

describe('ActionScopeSchema', () => {
  it('parses a valid project scope', () => {
    const parsed = ActionScopeSchema.parse({
      kind: 'project',
      grove_id: VALID_GROVE_ID,
      project_id: VALID_PROJECT_ID,
    });
    expect(parsed.kind).toBe('project');
    if (parsed.kind === 'project') {
      expect(parsed.grove_id).toBe(VALID_GROVE_ID);
      expect(parsed.project_id).toBe(VALID_PROJECT_ID);
    }
  });

  it('parses a valid grove scope', () => {
    const parsed = ActionScopeSchema.parse({ kind: 'grove', grove_id: VALID_GROVE_ID });
    expect(parsed.kind).toBe('grove');
  });

  it('parses a valid all-groves scope', () => {
    const parsed = ActionScopeSchema.parse({ kind: 'all-groves' });
    expect(parsed.kind).toBe('all-groves');
  });

  it('rejects an unknown kind', () => {
    expect(() => ActionScopeSchema.parse({ kind: 'global' })).toThrow();
  });

  it('rejects a project scope with an invalid project_id', () => {
    expect(() =>
      ActionScopeSchema.parse({
        kind: 'project',
        grove_id: VALID_GROVE_ID,
        project_id: 'not-a-grove-id',
      }),
    ).toThrow();
  });

  it('rejects an empty grove_id', () => {
    expect(() => ActionScopeSchema.parse({ kind: 'grove', grove_id: '' })).toThrow();
  });
});

describe('resolveActionScope', () => {
  it('uses the body scope when present', () => {
    const scope = resolveActionScope({
      body: { scope: { kind: 'all-groves' } },
      requestContext: undefined,
    });
    expect(scope.kind).toBe('all-groves');
  });

  it('falls back to the request context when scope is missing', () => {
    const scope = resolveActionScope({
      body: {},
      requestContext: {
        projectId: assertGroveProjectId(VALID_PROJECT_ID),
        groveId: VALID_GROVE_ID,
        machineId: 'm',
        sessionId: null,
        projectRoot: '/x',
        projectVaultDir: '/x/.myco',
        databasePath: '/x/.myco/myco.db',
        source: 'explicit',
      },
    });
    expect(scope.kind).toBe('project');
    if (scope.kind === 'project') {
      expect(scope.grove_id).toBe(VALID_GROVE_ID);
      expect(scope.project_id).toBe(VALID_PROJECT_ID);
    }
  });

  it('throws InvalidActionScopeError when scope is malformed', () => {
    expect(() =>
      resolveActionScope({ body: { scope: { kind: 'wrong' } }, requestContext: undefined }),
    ).toThrow(InvalidActionScopeError);
  });

  it('throws InvalidActionScopeError when no scope and no context', () => {
    expect(() => resolveActionScope({ body: {}, requestContext: undefined })).toThrow(
      InvalidActionScopeError,
    );
  });
});

describe('actionScopeKey', () => {
  it('produces a stable key for project scope', () => {
    expect(
      actionScopeKey({
        kind: 'project',
        grove_id: 'g1',
        project_id: assertGroveProjectId(VALID_PROJECT_ID),
      }),
    ).toBe(`project:g1:${VALID_PROJECT_ID}`);
  });

  it('produces a stable key for grove scope', () => {
    expect(actionScopeKey({ kind: 'grove', grove_id: 'g1' })).toBe('grove:g1');
  });

  it('produces a stable key for all-groves', () => {
    expect(actionScopeKey({ kind: 'all-groves' })).toBe('all-groves');
  });
});
