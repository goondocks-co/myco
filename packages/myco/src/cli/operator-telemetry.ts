import { AsyncLocalStorage } from 'node:async_hooks';
import { setTelemetrySuppression } from '@myco-server-worker/telemetry.js';

const operatorCommand = new AsyncLocalStorage<boolean>();
setTelemetrySuppression(() => operatorCommand.getStore() === true);

export const withoutServerTelemetry = <T>(action: () => T): T => operatorCommand.run(true, action);
