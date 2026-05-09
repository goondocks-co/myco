import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';
import type {
  MaintenanceLastIntegrity,
  GroveMaintenanceSummary,
  MaintenanceSummaryFlags,
  MaintenanceSummaryResponse,
} from '@myco/daemon/api/maintenance';
import type {
  ProjectActivityRow,
  ProjectsActivityResponse,
} from '@myco/daemon/api/projects-activity';

export type {
  MaintenanceLastIntegrity,
  GroveMaintenanceSummary,
  MaintenanceSummaryFlags,
  ProjectActivityRow,
  ProjectsActivityResponse,
};
export type MaintenanceSummary = MaintenanceSummaryResponse;

export function useMaintenanceSummary() {
  return usePowerQuery<MaintenanceSummaryResponse>({
    queryKey: ['maintenance-summary'],
    queryFn: ({ signal }) => fetchJson<MaintenanceSummaryResponse>('/maintenance/summary', { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}

export function useProjectsActivity() {
  return usePowerQuery<ProjectsActivityResponse>({
    queryKey: ['projects-activity'],
    queryFn: ({ signal }) => fetchJson<ProjectsActivityResponse>('/projects/activity', { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}
