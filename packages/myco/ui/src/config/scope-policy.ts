export { scopePolicyForPath, type Tier } from '@myco/config/scope';

export const TIER_LABEL: Record<string, string> = {
  machine: 'Machine', grove: 'Grove', project: 'Project', local: 'Personal',
};
export const TIER_TOOLTIP: Record<string, string> = {
  machine: 'Every Grove on this machine',
  grove: 'Every project in this Grove',
  project: 'This project, shared via the repo',
  local: 'Personal — this project, on this machine (not shared via git)',
};
