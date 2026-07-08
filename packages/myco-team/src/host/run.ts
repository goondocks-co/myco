/**
 * The real {@link CommandRunner} for Team Host orchestration — a thin spawn
 * wrapper shared by binary provisioning, the system-service supervisor, and the
 * headscale/tailscale CLI seams.
 *
 * The implementation now lives in the shared `@myco/host/overlay-binaries.ts`
 * (as `realCommandRunner`) so the host and the member (`myco join`, Task 2.2)
 * share ONE runner. Re-exported here under the name `overlay.ts` and the rest of
 * the host orchestration already import.
 */
export { realCommandRunner as realRunner } from '@myco/host/overlay-binaries.js';
export type { CommandRunner } from '@myco/host/overlay-binaries.js';
