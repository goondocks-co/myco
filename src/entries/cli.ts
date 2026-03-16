#!/usr/bin/env node
import { ensureNativeDeps } from '../native-deps.js';
ensureNativeDeps();
await import('../cli.js');
