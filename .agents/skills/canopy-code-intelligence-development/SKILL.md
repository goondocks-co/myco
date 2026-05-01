---
name: myco:canopy-code-intelligence-development
description: |
  Comprehensive procedures for building and extending Myco's Canopy code intelligence system.
  Covers agent harness task standardization, three-layer file exclusion models, context injection 
  and attribution pipelines, hook response shape compatibility, local-only aggregation architecture,
  and scanner configuration workflows. Apply when developing file indexing capabilities, extending 
  intelligence features, or integrating code analysis workflows, even if the user doesn't explicitly 
  ask for canopy system development.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Canopy Code Intelligence Development

The Canopy code intelligence system provides contextual file awareness and injection capabilities for Myco's agent pipeline. This skill covers the architectural patterns, integration workflows, and extension procedures needed to build and maintain Canopy's file indexing, context injection, and attribution tracking capabilities.

## Prerequisites

- Myco project with `.myco/` vault directory initialized
- Understanding of agent harness task patterns in the codebase
- Familiarity with symbiont manifest structure (`.agents/symbionts/`)
- SQLite schema knowledge for local aggregation columns
- Canopy implementation modules (to be developed when implementing this system)

## Procedure 1: Agent Harness Task Standardization

Convert canopy operations from bespoke executors to standard harness tasks for unified configuration, local model routing, and resource isolation.

### Task Migration Pattern

1. **Remove dedicated schedulers/executors**:
```typescript
// Before: Custom executor in daemon schedulers
// After: Standard task in agent task definitions
export const canopyDescribeTask: AgentTask = {
  name: 'canopy-describe',
  description: 'Generate file descriptions for code intelligence',
  phases: ['describe'],
  // Standard harness configuration
}
```

2. **Unify configuration paths**:
```typescript
// Use standard task configuration instead of custom config
const config = await getTaskConfig('canopy-describe');
// Leverage harness model routing and resource limits
```

3. **Enable local model support**:
```typescript
// Harness automatically handles local model routing
// Task can specify model requirements in manifest
const response = await harness.invoke({
  model: config.model || 'claude-3-5-sonnet-latest',
  // Harness applies local model multipliers automatically
});
```

### Configuration Integration

Update `myco.yaml` to use task-based configuration:
```yaml
agents:
  tasks:
    canopy-describe:
      enabled: true
      model: claude-3-5-sonnet-latest
      schedule: "0 */6 * * *"  # Every 6 hours
```

Remove legacy canopy-specific scheduler configuration blocks.

### Two-Mode Operation Pattern

`canopy-describe` supports both single-row and batch modes:

**Mode 1 — Single-row** (manual UI trigger or per-row events):
```typescript
// Process specific file
await processCanopyEntry(projectId, contentHash);
```

**Mode 2 — Batch** (scheduled task, bulk operations):
```typescript
// Process multiple files in transaction
const batch = await findPendingEntries(batchSize);
await processBatch(batch);
```

**Critical Gotcha**: Local models require batch_size tuning based on tool-call limits, not context windows. Batch size is a **tool-emission ceiling**, not a context budget.

## Procedure 2: Three-Layer File Exclusion Configuration

Implement the hierarchical exclusion model: Layer 1 (gitignore automatic), Layer 2 (Myco-managed), Layer 3 (user custom).

### Layer 1: Automatic Gitignore Integration

Implement gitignore pattern parsing and application automatically:

```typescript
// Create gitignore integration module when implementing
function isGitIgnored(filePath: string): boolean {
  // Parse .gitignore files from project root upward
  // Apply standard gitignore pattern matching
  // Return true if file matches any ignore pattern
}

const shouldIndex = !isGitIgnored(filePath);
```

### Layer 2: Myco-Managed Fixed Set

Configure system exclusions in canopy exclusion configuration:

```typescript
export const MYCO_MANAGED_EXCLUSIONS = [
  // Fixed exclusions
  'node_modules/**',
  '.git/**', 
  '.myco/**',
  '*.log',
  '*.tmp',
  
  // Dynamic symbiont directories
  ...getSymbiontExclusionPaths(),
];

function getSymbiontExclusionPaths(): string[] {
  // Read from .agents/symbionts/ manifests
  // Extract directories that should be excluded
}
```

### Layer 3: User Custom Patterns

Allow user overrides in `myco.yaml`:

```yaml
canopy:
  exclusions:
    # User can add custom patterns
    - "docs/drafts/**"
    - "*.private.*"
    # Cannot override Layer 1 or Layer 2
```

### Composition Logic

```typescript
function shouldExcludeFile(filePath: string): boolean {
  // Layer 1: gitignore (automatic)
  if (isGitIgnored(filePath)) return true;
  
  // Layer 2: Myco-managed
  if (matchesPatterns(filePath, MYCO_MANAGED_EXCLUSIONS)) return true;
  
  // Layer 3: User custom
  const userPatterns = getConfig().canopy?.exclusions || [];
  if (matchesPatterns(filePath, userPatterns)) return true;
  
  return false;
}
```

## Procedure 3: Context Injection and Attribution Pipeline

Implement multi-stage attribution tracking from injection through activity storage to aggregation.

### Attribution Registry Setup

Create pending attribution registry before injection:

```typescript
// Before tool use: Register pending attribution
await vault.query(`
  INSERT INTO pending_attributions (session_id, tool_use_id, file_paths, token_count)
  VALUES (?, ?, ?, ?)
`, [sessionId, toolUseId, JSON.stringify(injectedPaths), tokenCount]);
```

### PostToolUse Hook Integration

Consume pending attributions after tool completion:

```typescript
// In PostToolUse hook
async function recordAttribution(toolUseId: string) {
  const pending = await vault.get(`
    SELECT * FROM pending_attributions WHERE tool_use_id = ?
  `, [toolUseId]);
  
  if (!pending) return;
  
  // Convert to activity record
  await vault.query(`
    INSERT INTO activities (session_id, type, content, metadata)
    VALUES (?, 'canopy_injection', ?, ?)
  `, [
    pending.session_id,
    'Context injection completed',
    JSON.stringify({
      tool_use_id: toolUseId,
      file_paths: pending.file_paths,
      token_count: pending.token_count
    })
  ]);
  
  // Clean up pending
  await vault.query(`
    DELETE FROM pending_attributions WHERE tool_use_id = ?
  `, [toolUseId]);
}
```

### Canonical Path Handling

Always normalize paths to prevent attribution loss:

```typescript
import path from 'path';

function canonicalPath(filePath: string): string {
  // Convert to absolute path relative to project root
  const projectRoot = process.cwd();
  return path.resolve(projectRoot, filePath);
}

// Use canonical paths in attribution records
const canonicalPaths = injectedPaths.map(canonicalPath);
```

**Critical Gotcha**: Relative vs absolute path mismatches cause attribution loss in multi-stage pipelines. Always use canonical paths for attribution tracking.

### Per-Turn Aggregation Pattern

Update aggregates on each Stop (prompt-response cycle), not just SessionEnd:

```typescript
async function updatePerTurnAggregates(sessionId: string, toolUseId: string) {
  // Capture metrics after each Read tool completion
  const injection = await getInjectionMetrics(toolUseId);
  
  await vault.query(`
    UPDATE sessions 
    SET 
      canopy_injection_offered = ?,
      canopy_injection_tokens = ?,
      canopy_files_count = ?
    WHERE id = ?
  `, [
    injection.offered,
    injection.tokenCount,
    injection.fileCount,
    sessionId
  ]);
}
```

## Procedure 4: Hook Response Shape Integration

Handle agent-specific response formats and manifest-driven hook response mapping.

### Claude Code Integration Pattern

Claude Code expects JSON response format but falls back to stdout:

```typescript
// For Claude Code: Use hookSpecificOutput
export async function claudeCodePreToolUse(context: HookContext) {
  const injectionResult = await performContextInjection(context);
  
  return {
    hookSpecificOutput: {
      // JSON format for Claude Code consumption
      injectedFiles: injectionResult.files,
      tokenCount: injectionResult.tokenCount,
      summary: injectionResult.summary
    }
  };
}
```

**Critical Gotcha**: Claude Code PreToolUse hooks must return `hookSpecificOutput` JSON object. Stdout fallback doesn't work for PreToolUse timing.

### Manifest Matcher Field Requirement

Claude Code PreToolUse entries silently drop without `matcher` field:

```json
{
  "hooks": {
    "PreToolUse": {
      "command": "node .myco/hooks/canopy-inject.cjs",
      "matcher": "Read"
    }
  }
}
```

**Symptom**: `canopy_injection_tokens=NULL` for every Read despite valid hook configuration.

**Root Cause**: Missing or empty `matcher` field causes hook entry to be silently ignored during hook registration.

### Manifest-Driven Response Mapping

Configure response shapes in symbiont manifests:

```json
{
  "name": "claude-code",
  "hooks": {
    "PreToolUse": {
      "responseFormat": "json",
      "outputKey": "hookSpecificOutput"
    }
  }
}
```

### Generic Hook Pattern

For agents without specific requirements:

```typescript
export async function genericPreToolUse(context: HookContext) {
  const result = await performContextInjection(context);
  
  // Both JSON and stdout for maximum compatibility
  console.log(`Injected ${result.files.length} files (${result.tokenCount} tokens)`);
  
  return {
    hookSpecificOutput: result,
    // Some agents may only read stdout
  };
}
```

## Procedure 5: Local-Only Aggregation Setup

Configure Canopy metrics to remain local and never sync to D1 team storage.

### Session-Level Aggregate Columns

Add local-only columns to sessions table:

```sql
-- Migration: Add canopy aggregates to sessions
ALTER TABLE sessions ADD COLUMN canopy_files_indexed INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN canopy_tokens_injected INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN canopy_last_injection_at INTEGER;
```

### Team Sync Boundary Management

Configure sync exclusions in team sync configuration:

```typescript
export const SYNC_EXCLUSIONS = {
  sessions: [
    // Exclude canopy aggregates from team sync
    'canopy_files_indexed',
    'canopy_tokens_injected', 
    'canopy_last_injection_at'
  ],
  // Canopy-specific tables never sync
  excludeTables: [
    'canopy_file_index',
    'canopy_descriptions',
    'pending_attributions'
  ]
};
```

### Local Aggregation Logic

Update aggregates during canopy operations:

```typescript
async function updateSessionAggregates(sessionId: string, injection: CanopyInjection) {
  await vault.query(`
    UPDATE sessions 
    SET 
      canopy_files_indexed = canopy_files_indexed + ?,
      canopy_tokens_injected = canopy_tokens_injected + ?,
      canopy_last_injection_at = ?
    WHERE id = ?
  `, [
    injection.fileCount,
    injection.tokenCount,
    Date.now(),
    sessionId
  ]);
}
```

## Procedure 6: Scanner Configuration and Reconciliation

Implement file indexing workflows with tombstoning, scan optimization, and dynamic exclusion application.

### File Index Schema

Set up the canopy file index table:

```sql
CREATE TABLE canopy_file_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT UNIQUE NOT NULL,
  content_hash TEXT NOT NULL,
  last_modified INTEGER NOT NULL,
  description TEXT,
  indexed_at INTEGER NOT NULL,
  tombstoned_at INTEGER NULL
);

CREATE INDEX idx_canopy_path ON canopy_file_index(file_path);
CREATE INDEX idx_canopy_modified ON canopy_file_index(last_modified);
```

### Scan Mode Configuration

Configure different scanning strategies:

```typescript
type ScanMode = 'full' | 'incremental' | 'selective';

interface ScanConfig {
  mode: ScanMode;
  maxFiles?: number;
  filePatterns?: string[];
  forceReindex?: boolean;
}

async function performScan(config: ScanConfig) {
  switch (config.mode) {
    case 'full':
      return await fullDirectoryScan();
    case 'incremental':
      return await incrementalScan();
    case 'selective':
      return await selectivePatternScan(config.filePatterns);
  }
}
```

### Tombstoning Stale Entries

Mark removed files as tombstoned rather than deleting:

```typescript
async function reconcileFileIndex() {
  // Find indexed files that no longer exist
  const indexedFiles = await vault.query(`
    SELECT file_path FROM canopy_file_index 
    WHERE tombstoned_at IS NULL
  `);
  
  for (const row of indexedFiles) {
    const exists = await fs.access(row.file_path).then(() => true, () => false);
    if (!exists) {
      await vault.query(`
        UPDATE canopy_file_index 
        SET tombstoned_at = ? 
        WHERE file_path = ?
      `, [Date.now(), row.file_path]);
    }
  }
}
```

### Dynamic Exclusion Application

Apply exclusion rules during scanning:

```typescript
async function scanWithExclusions(): Promise<string[]> {
  const allFiles = await glob('**/*', { 
    ignore: ['node_modules/**', '.git/**'],
    dot: false 
  });
  
  return allFiles.filter(filePath => {
    // Apply three-layer exclusion model
    return !shouldExcludeFile(filePath);
  });
}
```

### Incremental Update Logic

Only reindex changed files:

```typescript
async function updateFileIndex(filePath: string) {
  const stats = await fs.stat(filePath);
  const contentHash = await calculateHash(filePath);
  
  const existing = await vault.get(`
    SELECT content_hash, last_modified FROM canopy_file_index 
    WHERE file_path = ?
  `, [filePath]);
  
  if (existing && 
      existing.content_hash === contentHash && 
      existing.last_modified === stats.mtime.getTime()) {
    // File unchanged, skip reindexing
    return;
  }
  
  // File changed, update index
  const description = await generateDescription(filePath);
  await vault.query(`
    INSERT OR REPLACE INTO canopy_file_index 
    (file_path, content_hash, last_modified, description, indexed_at)
    VALUES (?, ?, ?, ?, ?)
  `, [filePath, contentHash, stats.mtime.getTime(), description, Date.now()]);
}
```

## Procedure 7: Injection Failure Diagnostic Patterns

Systematic approaches to diagnose common Canopy injection failures discovered during Phase 0-1 implementation.

### Three-Layer Diagnostic Reference

**Layer 1: Hook Registration Failures**
- **Symptom**: `canopy_injection_tokens=NULL` consistently
- **Check**: Verify `matcher` field presence in manifest
- **Common cause**: Missing or empty `matcher: "Read"` in `.agents/symbionts/*/manifest.json`

**Layer 2: Path Resolution Mismatches**  
- **Symptom**: Attribution loss despite successful injection
- **Check**: Compare absolute vs relative path handling
- **Common cause**: Canonicalization inconsistencies in multi-stage pipelines

**Layer 3: Response Shape Incompatibility**
- **Symptom**: Hook executes but agent doesn't receive context
- **Check**: Verify `hookSpecificOutput` JSON structure
- **Common cause**: Agent-specific response format requirements not met

### Verbatim Transparency Validation

Ensure displayed injection content matches what agent receives:

```typescript
// Validate blob composition doesn't alter content
function validateVerbatimTransparency(originalBlob: string, displayBlob: string) {
  if (originalBlob !== displayBlob) {
    throw new Error('Verbatim transparency violation in Canopy display');
  }
}
```

**Critical Gotcha**: `composeBlobStructured()` can break verbatim transparency if it reformats content differently than what the agent actually sees.

### Per-Turn Attribution Verification

Verify attribution tracking works across prompt-response cycles:

```typescript
// Check attribution completeness after each tool use
async function verifyAttributionCompleteness(sessionId: string) {
  const pendingCount = await vault.get(`
    SELECT COUNT(*) as count FROM pending_attributions WHERE session_id = ?
  `, [sessionId]);
  
  if (pendingCount.count > 0) {
    console.warn(`${pendingCount.count} pending attributions not processed`);
  }
}
```

## Cross-Cutting Patterns

### Error Recovery

Canopy operations should be resilient to individual file failures:

```typescript
async function safeBulkOperation<T>(
  items: T[], 
  operation: (item: T) => Promise<void>
): Promise<void> {
  const errors: Array<{item: T, error: Error}> = [];
  
  for (const item of items) {
    try {
      await operation(item);
    } catch (error) {
      errors.push({ item, error });
      // Continue with next item
    }
  }
  
  if (errors.length > 0) {
    console.warn(`Canopy operation failed for ${errors.length} items:`, errors);
  }
}
```

### Configuration Validation

Validate canopy configuration on startup:

```typescript
function validateCanopyConfig(config: CanopyConfig): void {
  // Ensure exclusion patterns are valid
  for (const pattern of config.exclusions || []) {
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new Error(`Invalid exclusion pattern: ${pattern}`);
    }
  }
  
  // Validate scan limits
  if (config.maxFiles && config.maxFiles < 1) {
    throw new Error('maxFiles must be positive');
  }
}
```

### Phase 0 Foundation Architecture

The Phase 0 foundation establishes:

1. **Schema v25**: `canopy_entries` table with PK (project_id, content_hash)
2. **Scanner refresh**: Incremental file discovery and hash-based change detection
3. **Local aggregation**: Session-level metrics that never sync to D1
4. **Agent harness integration**: Standard task patterns replacing bespoke executors

**Mission**: Code intelligence for project comprehension, not token optimization. Focus on semantic understanding over cost reduction.