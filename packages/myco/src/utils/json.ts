/**
 * Re-exports the tolerant JSON helpers from `@myco-shared` so code in this
 * package can keep using the historical `@myco/utils/json` import path.
 */

export { tryParseJson, readJsonFile } from '@myco-shared/index.js';
