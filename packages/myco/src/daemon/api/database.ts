import type { DatabaseMaintenanceManager } from '../database/manager.js';
import { VacuumPrecheckError, VACUUM_ERROR_CODE } from '../database/types.js';
import type { RouteHandler, RouteRequest, RouteResponse } from '../router.js';

export interface DatabaseMaintenanceRouteDeps {
  createManager(req: RouteRequest): DatabaseMaintenanceManager;
}

export function createDatabaseMaintenanceHandlers(deps: DatabaseMaintenanceRouteDeps): {
  handleDetails: RouteHandler;
  handleOptimize: RouteHandler;
  handleVacuum: RouteHandler;
  handleReindex: RouteHandler;
  handleIntegrityCheck: RouteHandler;
} {
  return {
    handleDetails: (req) => handleDatabaseDetails(deps.createManager(req)),
    handleOptimize: (req) => handleDatabaseOptimize(deps.createManager(req)),
    handleVacuum: (req) => handleDatabaseVacuum(deps.createManager(req)),
    handleReindex: (req) => handleDatabaseReindex(deps.createManager(req)),
    handleIntegrityCheck: (req) => handleDatabaseIntegrityCheck(deps.createManager(req)),
  };
}

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
          error: VACUUM_ERROR_CODE,
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
