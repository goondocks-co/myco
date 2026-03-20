import type { MycoIndex } from '../index/sqlite.js';
import type { VectorIndex } from '../index/vectors.js';
import type { MycoConfig } from '../config/schema.js';

export interface OperationContext {
  vaultDir: string;
  config: MycoConfig;
  index: MycoIndex;
  vectorIndex?: VectorIndex;
  log?: (level: string, message: string, data?: Record<string, unknown>) => void;
}

// Each operation function takes OperationContext and delegates to existing modules.
// Implementation in subsequent tasks as each API route is built.
