import { ensureNativeDeps } from '../native-deps.js';
ensureNativeDeps();
await import('../daemon/main.js');
