import type { CredentialRow, MachineRow } from '../../packages/myco-server/ui/src/features/admin/wire';

/** Canonical machine answers for mounted dashboard tests that seed credential-shaped fixture data. */
export function machineRows(credentials: readonly CredentialRow[]): MachineRow[] {
  const groups = new Map<string, CredentialRow[]>();
  for (const row of credentials) {
    if (row.purpose !== 'member' || row.machineId === null) continue;
    const held = groups.get(row.machineId) ?? [];
    held.push(row);
    groups.set(row.machineId, held);
  }
  return [...groups].map(([machineId, held]): MachineRow => {
    const ordered = [...held].sort((a, b) => b.lineageStartedAt - a.lineageStartedAt || b.id.localeCompare(a.id));
    const live = ordered.filter((row) => row.live);
    const newest = ordered[0]!;
    const label = (live.find((row) => row.runtimeLabel?.trim()) ?? ordered.find((row) => row.runtimeLabel?.trim()))?.runtimeLabel?.trim() ?? null;
    const bytesByLineage = new Map<string, number>();
    for (const row of held) bytesByLineage.set(row.lineageRoot, Math.max(bytesByLineage.get(row.lineageRoot) ?? 0, row.bytesWritten));
    return {
      machineId, name: label, live: live.length > 0,
      member: { id: newest.memberId, label: null, revoked: false }, claimedAt: Math.min(...held.map((row) => row.lineageStartedAt)),
      credentialCount: held.length, liveCredentialCount: live.length,
      bytesWritten: [...bytesByLineage.values()].reduce((sum, bytes) => sum + bytes, 0), firstSeenAt: Math.min(...held.map((row) => row.lineageStartedAt)),
      standing: live.length > 0 ? 'allowed' : newest.revokedAt === null ? 'expired' : newest.revokedBy === 'lineage-replay' ? 'replayed' : 'stopped',
      stoppedBy: live.length === 0 && newest.revokedAt !== null && newest.revokedBy !== 'lineage-replay' ? newest.revokedBy : null,
      offers: null, lastContactAt: null, capture: [], lastCaptureAt: null, lastRunAt: null,
    };
  }).sort((a, b) => b.claimedAt - a.claimedAt || a.machineId.localeCompare(b.machineId));
}
