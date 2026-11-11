import type { RelationalStore } from '../core/adapters.js';
import { LEGACY_IMPORT_ADAPTER } from '@goondocks/myco-shared/member-protocol';
import { destinationArchivedAt, importedAuthoredRows, importedEvents } from '../db/capture/legacy-import.js';

export async function importedLegacyHistory(db: RelationalStore, projectId: string, machineId: string, eventIds: readonly string[], lifecycle = true): Promise<Set<string>> {
  return new Set(await importedEvents(db, { project: projectId, machine: machineId, adapter: LEGACY_IMPORT_ADAPTER, eventIds, lifecycle }));
}

export async function importedLegacyRows(db: RelationalStore, projectId: string, memberId: string, machineId: string, sporeIds: readonly string[], lineageIds: readonly string[]) {
  const held = await importedAuthoredRows(db, { project: projectId, member: memberId, machine: machineId, sporeIds, lineageIds });
  return { sporeIds: new Set(held.sporeIds), lineageIds: new Set(held.lineageIds) };
}

/** Exact Project identity includes archived destinations without admitting capture. */
export async function legacyDestinationState(db: RelationalStore, projectId: string): Promise<'active' | 'archived' | 'deleted'> {
  const archivedAt = await destinationArchivedAt(db, projectId);
  return archivedAt === undefined ? 'deleted' : archivedAt === null ? 'active' : 'archived';
}
