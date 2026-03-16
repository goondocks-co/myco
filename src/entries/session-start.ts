import { ensureNativeDeps } from '../native-deps.js';
ensureNativeDeps();
await import('../hooks/session-start.js');
