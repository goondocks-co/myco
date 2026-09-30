/**
 * The wire shapes Settings and a project's settings read, as the dashboard
 * declares them, match the server's.
 *
 * `features/admin/settings/wire.ts` and `features/admin/project/wire.ts`
 * declare the leaves, the provider keys, titling's progress, a project's
 * capabilities, its repository and its release tracking; this file holds each
 * to the server's own declaration. The assertions are types: `npm run
 * typecheck:tests` fails when a shape drifts, and the one runtime expectation
 * keeps the file a test Bun collects.
 */
import { describe, expect, it } from 'bun:test';
import type * as Settings from '../../packages/myco-server/ui/src/features/admin/settings/wire.ts';
import type * as Project from '../../packages/myco-server/ui/src/features/admin/project/wire.ts';
import type { SecretDescription } from '../../packages/myco-server/src/core/secrets.ts';
import type { ProjectCapability } from '../../packages/myco-server/src/core/settings.ts';
import type { TitlingBackfillProgress } from '../../packages/myco-server/src/core/titling.ts';
import type { RepositoryConnection } from '../../packages/myco-server/src/core/repositories.ts';
import type { ReleaseCheck, ReleaseProvenanceView } from '../../packages/myco-server/src/core/release-provenance.ts';

/** True only when each type is assignable to the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** True when what the server sends carries every field the dashboard reads, typed as it reads it. */
type Reads<Server, Dashboard> = [Server] extends [Dashboard] ? true : false;

/** `GET /api/settings`: one leaf as `deploymentLeaves` builds it. */
type ServerLeaf = { leaf: string; configured: boolean; value: unknown; updatedAt: number | null; updatedBy: string | null };
/** `GET /api/secrets`: each slot named and described, as `handleSecrets` answers. */
type ServerSecret = { name: string } & SecretDescription;

const SAME: [
  Same<Settings.LeafRow, ServerLeaf>,
  Same<Omit<Settings.SecretRow, 'name'>, SecretDescription>,
  Same<Project.KeyDescription, SecretDescription>,
  Same<Project.ReleaseCheck, ReleaseCheck>,
] = [true, true, true, true];

const READS: [
  Reads<{ persisted: true; leaves: ServerLeaf[] }, Settings.SettingsAnswer>,
  Reads<{ secrets: ServerSecret[] }, Settings.SecretsAnswer>,
  Reads<TitlingBackfillProgress, Settings.TitlingBackfillProgress>,
  Reads<{ capabilities: Record<ProjectCapability, boolean> }, Project.CapabilitiesAnswer>,
  Reads<RepositoryConnection, Project.RepositoryRow>,
  Reads<{ repository: RepositoryConnection | null }, Project.RepositoryAnswer>,
  Reads<ReleaseProvenanceView, Project.ReleaseProvenanceRow>,
  Reads<{ releaseProvenance: ReleaseProvenanceView }, Project.ReleaseProvenanceAnswer>,
] = [true, true, true, true, true, true, true, true];

describe("Settings' and project settings' wire shapes", () => {
  it('are held to the server declarations by the tests typecheck', () => {
    expect([...SAME, ...READS].every(Boolean)).toBe(true);
  });
});
