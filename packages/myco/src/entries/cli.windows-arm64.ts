/**
 * Per-target entry — windows-arm64.
 *
 * Neither native artifact has a Windows ARM64 build (sqlite-vec publishes none), so this entry embeds nothing and
 * declares so before the CLI runs. Logging in, capture, the worker, the runner and upgrades run as on every other
 * target; a verb that hosts a Deployment natively or opens one's data files refuses (`runtime/native-deps.ts`).
 */

import { registerNoNativeDeps } from '../runtime/native-deps.js';
import { setPluginVersion } from '../version.js';
import { dispatch } from './dispatch.js';
import pkg from '../../package.json' with { type: 'json' };

setPluginVersion(pkg.version);

await dispatch(() => registerNoNativeDeps({ target: 'windows-arm64' }));
