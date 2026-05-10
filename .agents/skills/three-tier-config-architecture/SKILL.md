---
name: myco:three-tier-config-architecture
description: |
  Comprehensive procedures for implementing and managing Myco's three-tier configuration architecture with Machine/Grove/Project scope hierarchy. Covers config storage design with scope enforcement patterns, TypeScript compile-time scope validation, multi-tier settings UI development, hierarchical config merging and override resolution strategies, and migration workflows for scope boundary evolution. Use this when implementing new configuration settings, refactoring config scope boundaries, building scope-aware editing interfaces, or migrating configuration data between tiers, even if the user doesn't explicitly ask for three-tier architecture guidance.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Three-Tier Configuration Architecture and Management

Myco's configuration system implements a three-tier hierarchy: Machine (global), Grove (shared across projects), and Project (local overrides). This architecture enables flexible configuration management with clear scope boundaries and inheritance patterns. These procedures cover the full lifecycle from storage design through migration patterns.

## Prerequisites

- Understanding of Myco's Machine/Grove/Project identity model
- Familiarity with TypeScript type system for compile-time validation
- Access to the codebase at `packages/myco/src/config/` and `packages/myco/ui/src/pages/`
- Knowledge of the settings schema format and validation patterns

## Procedure A: Implementing Three-Tier Config Storage Design

### 1. Define the Configuration Schema with Scope Metadata

Create type definitions that include scope information for each setting:

```typescript
// packages/myco/src/config/schema.ts
interface ConfigSetting<T> {
  value: T;
  scope: 'machine' | 'grove' | 'project';
  defaultValue: T;
  description: string;
  validation?: (value: T) => boolean;
}

interface MycoConfig {
  agentPipeline: ConfigSetting<{
    enabled: boolean;
    maxTurns: number;
  }> & { scope: 'grove' };
  
  vault: ConfigSetting<{
    location: string;
  }> & { scope: 'project' };
  
  telemetry: ConfigSetting<{
    enabled: boolean;
  }> & { scope: 'machine' };
}
```

### 2. Implement Storage Layer with Scope-Aware Persistence

Design storage that respects tier boundaries:

```typescript
// packages/myco/src/config/storage.ts
import { resolveGlobalConfigPath, resolveGroveConfigPath } from '../grove/paths.js';

class ConfigStorage {
  private machineConfigPath = resolveGlobalConfigPath();
  private projectConfigPath = '.myco/myco.yaml';
  
  async readTieredConfig<K extends keyof MycoConfig>(
    key: K,
    context: { grove?: string; project?: string }
  ): Promise<MycoConfig[K]['value']> {
    const setting = configSchema[key];
    
    switch (setting.scope) {
      case 'machine':
        return this.readMachineConfig(key);
      case 'grove':
        if (!context.grove) throw new Error(`Grove context required for ${key}`);
        return this.readGroveConfig(key, context.grove);
      case 'project':
        if (!context.project) throw new Error(`Project context required for ${key}`);
        return this.readProjectConfig(key);
    }
  }
}
```

### 3. Enforce Scope Boundaries with Runtime Validation

Implement guards that prevent cross-scope access violations:

```typescript
// packages/myco/src/config/guards.ts
class ScopeValidator {
  validateWriteAccess(
    key: keyof MycoConfig,
    targetScope: 'machine' | 'grove' | 'project',
    context: ConfigContext
  ): void {
    const setting = configSchema[key];
    
    if (setting.scope !== targetScope) {
      throw new Error(
        `Setting ${key} has scope '${setting.scope}' but attempted write to '${targetScope}'`
      );
    }
    
    if (setting.scope === 'grove' && !context.grove) {
      throw new Error(`Grove context required for grove-scoped setting ${key}`);
    }
    
    if (setting.scope === 'project' && (!context.grove || !context.project)) {
      throw new Error(`Full grove/project context required for project-scoped setting ${key}`);
    }
  }
}
```

## Procedure B: Type-Level Scope Enforcement and Compile-Time Safety

### 1. Design Scope-Aware Type System

Create TypeScript patterns that enforce scope at compile time:

```typescript
// packages/myco/src/config/types.ts
type ScopedConfig<S extends 'machine' | 'grove' | 'project'> = {
  [K in keyof MycoConfig as MycoConfig[K]['scope'] extends S ? K : never]: MycoConfig[K]['value'];
};

type MachineConfig = ScopedConfig<'machine'>;
type GroveConfig = ScopedConfig<'grove'>;
type ProjectConfig = ScopedConfig<'project'>;

type ConfigAccessor<C extends ConfigContext> = 
  C extends { grove: string; project: string } ? ProjectConfig & GroveConfig & MachineConfig :
  C extends { grove: string } ? GroveConfig & MachineConfig :
  MachineConfig;
```

### 2. Implement Context-Dependent Config API

Build APIs that expose only valid settings based on current context:

```typescript
// packages/myco/src/config/accessor.ts
import { loadConfig, updateConfig } from './loader.js';

class TypedConfigAccessor<C extends ConfigContext> {
  constructor(private context: C) {}
  
  get<K extends keyof ConfigAccessor<C>>(key: K): Promise<ConfigAccessor<C>[K]> {
    return this.storage.readTieredConfig(key, this.context);
  }
  
  async set<K extends keyof ConfigAccessor<C>>(
    key: K,
    value: ConfigAccessor<C>[K]
  ): Promise<void> {
    const setting = configSchema[key];
    this.validator.validateWriteAccess(key, setting.scope, this.context);
    return updateConfig(this.getConfigPath(setting.scope), { [key]: value });
  }
}

// Usage examples:
const machineAccessor = new TypedConfigAccessor({ machine: true });
await machineAccessor.get('telemetry'); // ✓ Valid

const projectAccessor = new TypedConfigAccessor({ 
  grove: 'my-org', 
  project: 'my-project' 
});
await projectAccessor.get('vault'); // ✓ Valid
await projectAccessor.get('telemetry'); // ✓ Valid - inherited
```

### 3. Create Scope-Aware Utility Types

Develop helper types for common scope operations:

```typescript
// packages/myco/src/config/utilities.ts
type SettingsInScope<S extends 'machine' | 'grove' | 'project'> = 
  keyof ScopedConfig<S>;

const isMachineScoped = <K extends keyof MycoConfig>(key: K): boolean =>
  configSchema[key].scope === 'machine';

const isValidInContext = <K extends keyof MycoConfig, C extends ConfigContext>(
  key: K,
  context: C
): key is keyof ConfigAccessor<C> => {
  const scope = configSchema[key].scope;
  return scope === 'machine' || 
         (scope === 'grove' && 'grove' in context) ||
         (scope === 'project' && 'project' in context);
};
```

## Procedure C: Settings UI Patterns for Multi-Tier Editing

### 1. Build Scope-Aware Form Components

Create UI components that indicate and enforce scope boundaries:

```typescript
// packages/myco/ui/src/components/ScopedSettingField.tsx
import React from 'react';
import type { MycoConfig } from '@myco/config/schema.js';

interface ScopedSettingFieldProps<K extends keyof MycoConfig> {
  settingKey: K;
  context: ConfigContext;
  value: MycoConfig[K]['value'];
  onChange: (value: MycoConfig[K]['value']) => void;
}

export function ScopedSettingField<K extends keyof MycoConfig>({
  settingKey,
  context,
  value,
  onChange
}: ScopedSettingFieldProps<K>) {
  const setting = configSchema[settingKey];
  const canEdit = isValidInContext(settingKey, context);
  const inheritanceSource = getInheritanceSource(settingKey, context);
  
  return (
    <div className="scoped-setting-field">
      <div className="setting-header">
        <label>{setting.description}</label>
        <ScopeBadge scope={setting.scope} />
        {inheritanceSource && <InheritanceBadge source={inheritanceSource} />}
      </div>
      
      <SettingInput
        value={value}
        onChange={onChange}
        disabled={!canEdit}
        validation={setting.validation}
      />
      
      {!canEdit && (
        <div className="edit-hint">
          This {setting.scope}-scoped setting can only be edited in {setting.scope} context
        </div>
      )}
    </div>
  );
}
```

### 2. Implement Multi-Tier Settings Interface

Create interfaces that show inheritance relationships:

```typescript
// packages/myco/ui/src/pages/TieredSettingsPanel.tsx
import React, { useState, useMemo } from 'react';
import { useScopedConfig } from '../hooks/use-scoped-config.js';

export function TieredSettingsPanel() {
  const [activeTab, setActiveTab] = useState<'machine' | 'grove' | 'project'>('project');
  const context = useConfigContext();
  const { config, updateConfig } = useScopedConfig();
  
  const visibleSettings = useMemo(() => {
    switch (activeTab) {
      case 'machine':
        return Object.keys(configSchema).filter(key => 
          configSchema[key].scope === 'machine'
        );
      case 'grove':
        return Object.keys(configSchema).filter(key =>
          ['grove', 'machine'].includes(configSchema[key].scope)
        );
      case 'project':
        return Object.keys(configSchema);
    }
  }, [activeTab]);
  
  return (
    <div className="tiered-settings-panel">
      <ScopeTabNavigation
        activeTab={activeTab}
        onTabChange={setActiveTab}
        context={context}
      />
      
      <div className="settings-grid">
        {visibleSettings.map(settingKey => (
          <ScopedSettingField
            key={settingKey}
            settingKey={settingKey}
            context={getContextForScope(activeTab, context)}
            value={config[settingKey]}
            onChange={(value) => updateConfig(settingKey, value, activeTab)}
          />
        ))}
      </div>
    </div>
  );
}
```

### 3. Design Inheritance Visualization

Build components that clearly show override relationships:

```typescript
// packages/myco/ui/src/components/InheritanceVisualization.tsx
import React from 'react';

interface InheritanceChainProps {
  settingKey: keyof MycoConfig;
  context: ConfigContext;
}

export function InheritanceChain({ settingKey, context }: InheritanceChainProps) {
  const inheritanceChain = buildInheritanceChain(settingKey, context);
  
  return (
    <div className="inheritance-chain">
      {inheritanceChain.map((tier, index) => (
        <div key={tier.scope} className="inheritance-tier">
          <div className={`tier-badge ${tier.isActive ? 'active' : 'overridden'}`}>
            {tier.scope}
          </div>
          <div className="tier-value">{JSON.stringify(tier.value)}</div>
          {index < inheritanceChain.length - 1 && (
            <div className="inheritance-arrow">→</div>
          )}
        </div>
      ))}
    </div>
  );
}

function buildInheritanceChain(settingKey: keyof MycoConfig, context: ConfigContext) {
  const chain = [];
  
  chain.push({
    scope: 'machine',
    value: getMachineValue(settingKey),
    isActive: configSchema[settingKey].scope === 'machine'
  });
  
  if (context.grove) {
    chain.push({
      scope: 'grove',
      value: getGroveValue(settingKey, context.grove),
      isActive: configSchema[settingKey].scope === 'grove'
    });
  }
  
  if (context.project) {
    chain.push({
      scope: 'project',
      value: getProjectValue(settingKey, context),
      isActive: configSchema[settingKey].scope === 'project'
    });
  }
  
  return chain;
}
```

## Procedure D: Config Merging and Override Resolution

### 1. Implement Hierarchical Merging Algorithm

Create merging logic that respects precedence rules (Project > Grove > Machine):

```typescript
// packages/myco/src/config/merger.ts
import { loadConfig } from './loader.js';
import { deepMergeConfig } from './loader.js';

class ConfigMerger {
  async resolveConfig<K extends keyof MycoConfig>(
    key: K,
    context: ConfigContext
  ): Promise<MycoConfig[K]['value']> {
    const setting = configSchema[key];
    
    if (setting.scope === 'machine') {
      return this.readMachineValue(key);
    }
    
    if (setting.scope === 'grove' && context.grove) {
      return this.readGroveValue(key, context.grove) ?? 
             this.readMachineValue(key);
    }
    
    if (setting.scope === 'project' && context.project) {
      return this.readProjectValue(key, context) ??
             (context.grove ? this.readGroveValue(key, context.grove) : null) ??
             this.readMachineValue(key);
    }
    
    return setting.defaultValue;
  }
}
```

### 2. Design Conflict Resolution Patterns

Handle cases where multiple tiers have conflicting values:

```typescript
// packages/myco/src/config/conflict-resolution.ts
interface ConflictResolutionStrategy<T> {
  resolve(values: { machine?: T; grove?: T; project?: T }): T;
}

class PrecedenceStrategy<T> implements ConflictResolutionStrategy<T> {
  resolve(values: { machine?: T; grove?: T; project?: T }): T {
    return values.project ?? values.grove ?? values.machine!;
  }
}

class MergeStrategy<T extends Record<string, any>> implements ConflictResolutionStrategy<T> {
  resolve(values: { machine?: T; grove?: T; project?: T }): T {
    return deepMergeConfig(
      deepMergeConfig(values.machine || {} as T, values.grove || {}),
      values.project || {}
    );
  }
}

function getResolutionStrategy<K extends keyof MycoConfig>(
  key: K
): ConflictResolutionStrategy<MycoConfig[K]['value']> {
  const setting = configSchema[key];
  
  if (setting.mergeStrategy === 'deep-merge') {
    return new MergeStrategy();
  }
  
  return new PrecedenceStrategy();
}
```

### 3. Implement Fallback and Validation Chains

Create robust fallback mechanisms with validation:

```typescript
// packages/myco/src/config/fallback.ts
import { MycoConfigSchema } from './schema.js';

class ConfigFallbackChain {
  async resolveWithFallback<K extends keyof MycoConfig>(
    key: K,
    context: ConfigContext
  ): Promise<MycoConfig[K]['value']> {
    const setting = configSchema[key];
    const resolutionChain = this.buildResolutionChain(key, context);
    
    for (const resolver of resolutionChain) {
      try {
        const value = await resolver();
        
        if (value !== undefined && this.validateValue(key, value)) {
          return value;
        }
      } catch (error) {
        console.warn(`Failed to resolve ${key} from ${resolver.name}:`, error);
        continue;
      }
    }
    
    console.info(`Using default value for ${key}`);
    return setting.defaultValue;
  }
  
  private buildResolutionChain<K extends keyof MycoConfig>(
    key: K,
    context: ConfigContext
  ): Array<() => Promise<MycoConfig[K]['value'] | undefined>> {
    const chain: Array<() => Promise<MycoConfig[K]['value'] | undefined>> = [];
    
    if (context.project) {
      chain.push(async () => this.readProjectValue(key, context));
    }
    
    if (context.grove) {
      chain.push(async () => this.readGroveValue(key, context.grove));
    }
    
    chain.push(async () => this.readMachineValue(key));
    
    return chain;
  }
  
  private validateValue<K extends keyof MycoConfig>(
    key: K,
    value: MycoConfig[K]['value']
  ): boolean {
    const setting = configSchema[key];
    if (setting.validation) {
      return setting.validation(value);
    }
    
    const result = MycoConfigSchema.shape[key].safeParse(value);
    return result.success;
  }
}
```

## Procedure E: Migration Patterns for Scope Boundary Changes

### 1. Design Scope Migration Workflows

Create procedures for moving settings between tiers:

```typescript
// packages/myco/src/config/migration.ts
import { loadConfig, saveConfig } from './loader.js';

interface ScopeMigration {
  settingKey: keyof MycoConfig;
  fromScope: 'machine' | 'grove' | 'project';
  toScope: 'machine' | 'grove' | 'project';
  strategy: 'preserve-values' | 'reset-to-default' | 'custom';
  customMigration?: (currentValues: any[]) => any;
}

class ScopeMigrationRunner {
  async migrateSetting(migration: ScopeMigration): Promise<void> {
    console.log(`Migrating ${migration.settingKey} from ${migration.fromScope} to ${migration.toScope}`);
    
    const existingValues = await this.collectExistingValues(
      migration.settingKey,
      migration.fromScope
    );
    
    await this.clearOldScopeStorage(migration.settingKey, migration.fromScope);
    
    const migratedValues = await this.applyMigrationStrategy(
      migration,
      existingValues
    );
    
    await this.writeToNewScope(
      migration.settingKey,
      migration.toScope,
      migratedValues
    );
    
    await this.updateConfigSchema(migration.settingKey, migration.toScope);
    
    console.log(`Migration completed for ${migration.settingKey}`);
  }
  
  private async collectExistingValues(
    settingKey: keyof MycoConfig,
    fromScope: 'machine' | 'grove' | 'project'
  ): Promise<Map<string, any>> {
    const values = new Map();
    
    switch (fromScope) {
      case 'machine':
        values.set('machine', await this.readMachineValue(settingKey));
        break;
        
      case 'grove':
        const groves = await this.listAllGroves();
        for (const grove of groves) {
          const value = await this.readGroveValue(settingKey, grove);
          if (value !== undefined) {
            values.set(`grove:${grove}`, value);
          }
        }
        break;
        
      case 'project':
        const projects = await this.listAllProjects();
        for (const project of projects) {
          const value = await this.readProjectValue(settingKey, project.context);
          if (value !== undefined) {
            values.set(`project:${project.grove}:${project.name}`, value);
          }
        }
        break;
    }
    
    return values;
  }
}
```

### 2. Implement Backward Compatibility During Migration

Maintain compatibility while scope changes are in progress:

```typescript
// packages/myco/src/config/compatibility.ts
import { loadConfig } from './loader.js';

class BackwardCompatibilityLayer {
  private migrationMap: Map<keyof MycoConfig, ScopeMigration> = new Map();
  
  registerMigration(migration: ScopeMigration): void {
    this.migrationMap.set(migration.settingKey, migration);
  }
  
  async readWithCompatibility<K extends keyof MycoConfig>(
    key: K,
    context: ConfigContext
  ): Promise<MycoConfig[K]['value']> {
    const migration = this.migrationMap.get(key);
    
    if (!migration) {
      const config = await loadConfig(this.getConfigPath(context));
      return config[key];
    }
    
    try {
      return await this.readFromScope(key, migration.toScope, context);
    } catch (error) {
      console.warn(`Failed to read ${key} from new scope ${migration.toScope}, falling back to old scope`);
      return await this.readFromScope(key, migration.fromScope, context);
    }
  }
}
```

### 3. Build Migration Validation and Rollback

Create safety mechanisms for migration operations:

```typescript
// packages/myco/src/config/migration-validation.ts
interface ValidationResult {
  valid: boolean;
  issues: string[];
  warnings: string[];
}

interface RollbackPlan {
  settingKey: keyof MycoConfig;
  originalScope: 'machine' | 'grove' | 'project';
  targetScope: 'machine' | 'grove' | 'project';
  backup: any;
  rollbackSteps: string[];
}

class MigrationValidator {
  async validateMigration(migration: ScopeMigration): Promise<ValidationResult> {
    const issues: string[] = [];
    
    if (!(migration.settingKey in configSchema)) {
      issues.push(`Setting '${migration.settingKey}' not found in schema`);
    }
    
    const isValidTransition = this.validateScopeTransition(
      migration.fromScope,
      migration.toScope
    );
    if (!isValidTransition) {
      issues.push(`Invalid scope transition: ${migration.fromScope} → ${migration.toScope}`);
    }
    
    const dataLossRisk = await this.assessDataLossRisk(migration);
    if (dataLossRisk.high) {
      issues.push(`High data loss risk: ${dataLossRisk.reason}`);
    }
    
    if (migration.strategy === 'custom' && !migration.customMigration) {
      issues.push('Custom migration strategy requires customMigration function');
    }
    
    return {
      valid: issues.length === 0,
      issues,
      warnings: dataLossRisk.medium ? [dataLossRisk.reason] : []
    };
  }
  
  async createRollbackPlan(migration: ScopeMigration): Promise<RollbackPlan> {
    const backup = await this.createConfigBackup(migration.settingKey);
    
    return {
      settingKey: migration.settingKey,
      originalScope: migration.fromScope,
      targetScope: migration.toScope,
      backup,
      rollbackSteps: [
        'Restore original scope storage from backup',
        'Clear new scope storage',
        'Revert schema changes',
        'Update migration tracking'
      ]
    };
  }
  
  async executeRollback(plan: RollbackPlan): Promise<void> {
    console.log(`Rolling back migration for ${plan.settingKey}`);
    
    await this.restoreFromBackup(plan.backup, plan.originalScope);
    await this.clearScope(plan.settingKey, plan.targetScope);
    await this.updateConfigSchema(plan.settingKey, plan.originalScope);
    
    console.log(`Rollback completed for ${plan.settingKey}`);
  }
  
  private async createConfigBackup(settingKey: keyof MycoConfig): Promise<any> {
    const timestamp = Date.now();
    return {
      timestamp,
      settingKey,
      machine: await this.readMachineValue(settingKey),
      grove: await this.readAllGroveValues(settingKey),
      project: await this.readAllProjectValues(settingKey)
    };
  }
}
```

## Cross-Cutting Gotchas

- **Context validation**: Always validate that the current context provides sufficient scope for the requested setting. Missing grove or project context will cause runtime errors when accessing grove/project-scoped settings.

- **Schema evolution**: When adding new settings, choose the scope carefully. Moving settings between scopes later requires complex migration procedures. Start with the narrowest appropriate scope (project) and broaden if needed.

- **Type safety boundaries**: TypeScript compile-time validation only works if you use the typed accessors. Direct JSON manipulation bypasses all scope enforcement. Always use `TypedConfigAccessor` for config operations.

- **UI state synchronization**: Multi-tier settings interfaces can show stale data if not properly synchronized. Use reactive patterns or explicit refresh after scope changes to keep UI consistent with actual config state.

- **Migration atomicity**: Scope migrations are multi-step operations that can fail partway through. Always create rollback plans and validate migration steps before execution. Test migrations on non-production data first.

- **Config loader integration**: Always use `loadConfig()` and `updateConfig()` from `packages/myco/src/config/loader.ts` rather than direct file I/O. These functions handle the merging semantics and validation that make the three-tier system work correctly.