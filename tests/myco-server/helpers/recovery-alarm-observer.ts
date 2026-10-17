import { emit as productEmit, type TelemetryEvent } from '@myco-server-worker/telemetry.js';
export * from '@myco-server-worker/telemetry.js';

export const events: TelemetryEvent[] = [];
export const writes: string[] = [];

export function emit(event: TelemetryEvent): void {
  events.push(event);
  productEmit(event);
}
