import type { WorkerPrincipal } from '@myco-server-worker/core/worker-lease.js';

export const legacyWorker = (tokenId: string, machineId: string): WorkerPrincipal => ({ kind: 'member', tokenId, machineId });
