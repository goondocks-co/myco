import type { DatabaseMaintenanceManager } from '../database/manager.js';
import { VacuumPrecheckError } from '../database/types.js';
import type { RouteResponse } from '../router.js';

export async function handleDatabaseDetails(
  manager: DatabaseMaintenanceManager,
): Promise<RouteResponse> {
  const details = await manager.getDetails();
  return { body: details };
}

export async function handleDatabaseOptimize(
  manager: DatabaseMaintenanceManager,
): Promise<RouteResponse> {
  const result = await manager.optimize();
  return { body: result };
}

export async function handleDatabaseVacuum(
  manager: DatabaseMaintenanceManager,
): Promise<RouteResponse> {
  try {
    const result = await manager.vacuum();
    return { body: result };
  } catch (err) {
    if (err instanceof VacuumPrecheckError) {
      return {
        status: 409,
        body: {
          error: 'insufficient_disk_space',
          required_bytes: err.required_bytes,
          free_bytes: err.free_bytes,
        },
      };
    }
    throw err;
  }
}

export async function handleDatabaseReindex(
  manager: DatabaseMaintenanceManager,
): Promise<RouteResponse> {
  const result = await manager.reindex();
  return { body: result };
}

export async function handleDatabaseIntegrityCheck(
  manager: DatabaseMaintenanceManager,
): Promise<RouteResponse> {
  const result = await manager.integrityCheck();
  return { body: result };
}
