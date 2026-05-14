---
name: myco:three-tier-config-architecture
description: |
  Comprehensive procedures for implementing and managing Myco's three-tier configuration architecture with Machine/Grove/Project scope hierarchy. Covers config storage design with scope enforcement patterns, TypeScript compile-time scope validation, multi-tier settings UI development, hierarchical config merging and override resolution strategies, and migration workflows for scope boundary evolution. Use this when implementing new configuration settings, refactoring config scope boundaries, building scope-aware editing interfaces, or migrating configuration data between tiers, even if the user doesn't explicitly ask for three-tier architecture guidance.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Three-Tier Configuration Architecture and Management

Myco's configuration system implements a three-tier hierarchy: Machine (global), Grove (shared across projects), and Project (local overrides). This architecture enables flexible configuration management with clear scope boundaries and inheritance patterns, now enhanced with portable project identity via `.myco/project.toml`.

## Prerequisites

- Understanding of Myco's Machine/Grove/Project identity model with portable project.toml
- Familiarity with TypeScript type system for compile-time validation
- Access to the codebase at `packages/myco/src/config/` and `packages/myco/ui/src/pages/`
- Knowledge of the settings schema format and validation patterns
- Understanding of Grove identity architecture and binding_id patterns

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
  agentPipeline: ConfigSetting<{ enabled: boolean; maxTurns: number; }> & { scope: 'grove' };
  vault: ConfigSetting<{ location: string; }> & { scope: 'project' };
  telemetry: ConfigSetting<{ enabled: boolean; }> & { scope: 'machine' };
}
```

### 2. Implement Storage Layer with Scope-Aware Persistence

Design storage that respects tier boundaries and integrates with portable project identity:

```typescript
// packages/myco/src/config/storage.ts
import { resolveGlobalConfigPath, resolveGroveConfigPath } from '../grove/paths.js';
import { readProjectConfig } from '../grove/project-config.js';

class ConfigStorage {
  async readTieredConfig<K extends keyof MycoConfig>(
    key: K,
    context: { grove?: string; projectPath?: string }
  ): Promise<MycoConfig[K]['value']> {
    const setting = configSchema[key];
    
    switch (setting.scope) {
      case 'machine':
        return this.readMachineConfig(key);
      case 'grove':
        if (!context.grove) throw new Error(`Grove context required for ${key}`);
        return this.readGroveConfig(key, context.grove);
      case 'project':
        if (!context.projectPath) throw new Error(`Project path required for ${key}`);
        
        // Resolve portable project identity from project.toml
        const projectConfig = await readProjectConfig(context.projectPath);
        return this.readProjectConfig(key, projectConfig.binding_id);
    }
  }
}
```

### 3. Project.toml Integration for Portable Configuration

Integrate with the new portable project identity system:

```typescript
// packages/myco/src/config/project-integration.ts
import { readProjectConfig } from '../grove/project-config.js';

interface ProjectConfigContext {
  projectPath: string;
  bindingId: string;
  groveId?: string;
}

class ProjectConfigManager {
  async resolveProjectContext(projectPath: string): Promise<ProjectConfigContext> {
    const projectConfig = await readProjectConfig(projectPath);
    return {
      projectPath,
      bindingId: projectConfig.binding_id,
      groveId: projectConfig.grove_id
    };
  }
  
  async migrateProjectConfigToPortable(
    legacyProjectId: string,
    projectPath: string
  ): Promise<void> {
    const legacyConfig = await this.readLegacyProjectConfig(legacyProjectId);
    const context = await this.resolveProjectContext(projectPath);
    
    // Migrate configuration using binding_id as stable key
    await this.writeProjectConfigWithBindingId(legacyConfig, context.bindingId, projectPath);
    await this.removeLegacyProjectConfig(legacyProjectId);
  }
}
```

## Procedure B: Type-Level Scope Enforcement and Compile-Time Safety

### 1. Design Scope-Aware Type System

Create TypeScript patterns that enforce scope at compile time with portable project support:

```typescript
// packages/myco/src/config/types.ts
type ScopedConfig<S extends 'machine' | 'grove' | 'project'> = {
  [K in keyof MycoConfig as MycoConfig[K]['scope'] extends S ? K : never]: MycoConfig[K]['value'];
};

interface ConfigContext {
  machine?: boolean;
  grove?: string;
  projectPath?: string;
  bindingId?: string; // Portable project identifier
}

type ConfigAccessor<C extends ConfigContext> = 
  C extends { projectPath: string } ? ProjectConfig & GroveConfig & MachineConfig :
  C extends { grove: string } ? GroveConfig & MachineConfig :
  MachineConfig;
```

### 2. Implement Context-Dependent Config API

Build APIs that expose only valid settings based on current context:

```typescript
// packages/myco/src/config/accessor.ts
class TypedConfigAccessor<C extends ConfigContext> {
  private projectContext?: ProjectConfigContext;
  
  constructor(private context: C) {}
  
  async initialize(): Promise<void> {
    if (this.context.projectPath) {
      const projectConfig = await readProjectConfig(this.context.projectPath);
      this.projectContext = {
        projectPath: this.context.projectPath,
        bindingId: projectConfig.binding_id,
        groveId: projectConfig.grove_id
      };
    }
  }
  
  get<K extends keyof ConfigAccessor<C>>(key: K): Promise<ConfigAccessor<C>[K]> {
    return this.storage.readTieredConfig(key, this.context);
  }
  
  async set<K extends keyof ConfigAccessor<C>>(
    key: K,
    value: ConfigAccessor<C>[K]
  ): Promise<void> {
    const setting = configSchema[key];
    if (setting.scope === 'project' && this.projectContext) {
      return this.writeProjectConfigWithBinding(key, value, this.projectContext);
    }
    return updateConfig(this.getConfigPath(setting.scope), { [key]: value });
  }
}
```

## Procedure C: Settings UI Patterns for Multi-Tier Editing

### 1. Build Scope-Aware Form Components

Create UI components that indicate and enforce scope boundaries with portable project support:

```typescript
// packages/myco/ui/src/components/ScopedSettingField.tsx
export function ScopedSettingField<K extends keyof MycoConfig>({
  settingKey,
  context,
  value,
  onChange
}: ScopedSettingFieldProps<K>) {
  const setting = configSchema[settingKey];
  const projectContext = useProjectContext(context.projectPath);
  const canEdit = isValidInContext(settingKey, context);
  
  return (
    <div className="scoped-setting-field">
      <div className="setting-header">
        <label>{setting.description}</label>
        <ScopeBadge scope={setting.scope} />
        {projectContext?.bindingId && (
          <ProjectIdentityBadge bindingId={projectContext.bindingId} />
        )}
      </div>
      
      <SettingInput
        value={value}
        onChange={onChange}
        disabled={!canEdit}
        validation={setting.validation}
      />
    </div>
  );
}
```

### 2. Design Inheritance Visualization

Build components that clearly show override relationships with portable project identity:

```typescript
// packages/myco/ui/src/components/InheritanceVisualization.tsx
export function InheritanceChain({ settingKey, context }: InheritanceChainProps) {
  const projectContext = useProjectContext(context.projectPath);
  const inheritanceChain = buildInheritanceChain(settingKey, context, projectContext);
  
  return (
    <div className="inheritance-chain">
      {inheritanceChain.map((tier, index) => (
        <div key={tier.scope} className="inheritance-tier">
          <div className={`tier-badge ${tier.isActive ? 'active' : 'overridden'}`}>
            {tier.scope}
            {tier.scope === 'project' && projectContext?.bindingId && (
              <div className="binding-id-display">
                ID: {projectContext.bindingId.slice(0, 8)}...
              </div>
            )}
          </div>
          <div className="tier-value">{JSON.stringify(tier.value)}</div>
        </div>
      ))}
    </div>
  );
}
```

## Procedure D: Config Merging and Override Resolution

### 1. Implement Hierarchical Merging Algorithm

Create merging logic that respects precedence rules (Project > Grove > Machine) with portable project support:

```typescript
// packages/myco/src/config/merger.ts
class ConfigMerger {
  async resolveConfig<K extends keyof MycoConfig>(
    key: K,
    context: ConfigContext
  ): Promise<MycoConfig[K]['value']> {
    const setting = configSchema[key];
    
    if (setting.scope === 'project' && context.projectPath) {
      // Use portable project identity for configuration resolution
      const projectConfig = await readProjectConfig(context.projectPath);
      const projectContext = {
        projectPath: context.projectPath,
        bindingId: projectConfig.binding_id,
        groveId: projectConfig.grove_id
      };
      
      return this.readProjectValueWithBinding(key, projectContext) ??
             (context.grove ? this.readGroveValue(key, context.grove) : null) ??
             this.readMachineValue(key);
    }
    
    // Handle machine and grove scopes as before
    return setting.defaultValue;
  }
}
```

### 2. Design Conflict Resolution with Portable Project Context

Handle cases where multiple tiers have conflicting values:

```typescript
// packages/myco/src/config/conflict-resolution.ts
class PortableProjectMergeStrategy<T extends Record<string, any>> {
  resolve(values: { 
    machine?: T; 
    grove?: T; 
    project?: T;
    projectContext?: ProjectConfigContext;
  }): T {
    const baseConfig = deepMergeConfig(values.machine || {} as T, values.grove || {});
    
    // Apply project-specific overrides using binding_id context
    const projectConfig = this.enrichWithProjectContext(values.project || {}, values.projectContext);
    return deepMergeConfig(baseConfig, projectConfig);
  }
  
  private enrichWithProjectContext<T>(config: T, context?: ProjectConfigContext): T {
    if (!context) return config;
    return {
      ...config,
      _projectContext: {
        bindingId: context.bindingId,
        groveId: context.groveId
      }
    };
  }
}
```

## Procedure E: Migration Patterns for Scope Boundary Changes

### 1. Design Scope Migration Workflows

Create procedures for moving settings between tiers with portable project identity support:

```typescript
// packages/myco/src/config/migration.ts
interface ProjectMigrationContext {
  projectPath: string;
  legacyProjectId?: string;
  bindingId: string;
  groveId?: string;
}

class ScopeMigrationRunner {
  async migrateProjectToPortableIdentity(
    legacyProjectId: string,
    projectPath: string
  ): Promise<void> {
    // Read portable project identity
    const projectConfig = await readProjectConfig(projectPath);
    const migrationContext: ProjectMigrationContext = {
      projectPath,
      legacyProjectId,
      bindingId: projectConfig.binding_id,
      groveId: projectConfig.grove_id
    };
    
    // Migrate all project-scoped settings to use binding_id
    const projectSettings = Object.keys(configSchema).filter(
      key => configSchema[key].scope === 'project'
    );
    
    for (const settingKey of projectSettings) {
      await this.migrateProjectSetting(settingKey, migrationContext);
    }
  }
  
  private async migrateProjectSetting(
    settingKey: string,
    context: ProjectMigrationContext
  ): Promise<void> {
    // Read existing configuration with legacy ID
    const legacyValue = await this.readLegacyProjectValue(settingKey, context.legacyProjectId);
    
    if (legacyValue !== undefined) {
      // Write configuration using portable binding_id
      await this.writeProjectValueWithBinding(
        settingKey,
        legacyValue,
        context.bindingId,
        context.projectPath
      );
      await this.removeLegacyProjectValue(settingKey, context.legacyProjectId);
    }
  }
}
```

### 2. Automatic CLI-Driven Migration Patterns

`myco update` automatically handles scope migration for specific legacy configuration fields:

```typescript
// packages/myco/src/config/automatic-migration.ts
interface AutomaticMigrationRule {
  field: string;
  fromScope: 'project' | 'grove' | 'machine';
  toScope: 'project' | 'grove' | 'machine';
  condition?: (value: any) => boolean;
}

const AUTOMATIC_MIGRATION_RULES: AutomaticMigrationRule[] = [
  {
    field: 'embedding.run_in_deep_sleep',
    fromScope: 'project',
    toScope: 'grove'
  },
  {
    field: 'agent.scheduled_tasks_active_window_days', 
    fromScope: 'project',
    toScope: 'grove'
  }
];

class AutomaticMigrationProcessor {
  async processProjectToGroveMigration(projectPath: string): Promise<void> {
    const projectConfig = await loadConfig(path.join(projectPath, '.myco/myco.yaml'));
    const groveConfig = await loadGroveConfig();
    
    let hasProjectChanges = false;
    let hasGroveChanges = false;
    
    for (const rule of AUTOMATIC_MIGRATION_RULES) {
      if (rule.fromScope === 'project' && rule.toScope === 'grove') {
        const value = this.getNestedValue(projectConfig, rule.field);
        
        if (value !== undefined) {
          // Move value from project to grove config
          this.setNestedValue(groveConfig, rule.field, value);
          this.removeNestedValue(projectConfig, rule.field);
          
          hasProjectChanges = true;
          hasGroveChanges = true;
          
          console.log(`Migrated ${rule.field} from project to grove config`);
        }
      }
    }
    
    // Write updated configurations
    if (hasProjectChanges) {
      await updateConfig(path.join(projectPath, '.myco/myco.yaml'), projectConfig);
    }
    if (hasGroveChanges) {
      await saveGroveConfig(groveConfig);
    }
  }
  
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }
  
  private setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    const lastKey = keys.pop()!;
    const target = keys.reduce((current, key) => {
      current[key] = current[key] || {};
      return current[key];
    }, obj);
    target[lastKey] = value;
  }
  
  private removeNestedValue(obj: any, path: string): void {
    const keys = path.split('.');
    const lastKey = keys.pop()!;
    const target = keys.reduce((current, key) => current?.[key], obj);
    if (target) {
      delete target[lastKey];
    }
  }
}
```

**Migration Trigger:** The automatic migration is integrated into the `myco update` command workflow. When updating CLI hooks and MCP entries, the system checks for legacy configuration fields at the project level and migrates them to the Grove tier. This migration:

- Preserves the configured behavior (values are not lost)
- Makes settings available to all projects within the Grove
- Follows the principle that scope should broaden when settings prove useful across multiple projects
- Runs transparently during routine update operations

### 3. Implement Backward Compatibility During Migration

Maintain compatibility while scope changes are in progress:

```typescript
// packages/myco/src/config/compatibility.ts
class BackwardCompatibilityLayer {
  async readWithCompatibility<K extends keyof MycoConfig>(
    key: K,
    context: ConfigContext
  ): Promise<MycoConfig[K]['value']> {
    if (context.projectPath) {
      // Use portable project identity for configuration access
      const projectConfig = await readProjectConfig(context.projectPath);
      const enhancedContext = { ...context, bindingId: projectConfig.binding_id };
      return this.readConfigWithContext(key, enhancedContext);
    }
    
    const config = await loadConfig(this.getConfigPath(context));
    return config[key];
  }
}
```

### 4. Build Migration Validation and Rollback

Create safety mechanisms for migration operations with portable project support:

```typescript
// packages/myco/src/config/migration-validation.ts
class MigrationValidator {
  async validateMigration(migration: ScopeMigration): Promise<ValidationResult> {
    const issues: string[] = [];
    
    // Standard validation checks
    if (!(migration.settingKey in configSchema)) {
      issues.push(`Setting '${migration.settingKey}' not found in schema`);
    }
    
    // Validate portable project identity consistency
    if (migration.fromScope === 'project' || migration.toScope === 'project') {
      const projectConsistency = await this.validateProjectIdentityConsistency();
      if (!projectConsistency.valid) {
        issues.push(`Project identity consistency issues: ${projectConsistency.issues.join(', ')}`);
      }
    }
    
    return { valid: issues.length === 0, issues, warnings: [] };
  }
  
  private async validateProjectIdentityConsistency(): Promise<ValidationResult> {
    const issues: string[] = [];
    const projects = await this.listAllProjects();
    
    for (const project of projects) {
      try {
        const projectConfig = await readProjectConfig(project.path);
        if (!projectConfig.binding_id || !this.isValidBindingId(projectConfig.binding_id)) {
          issues.push(`Invalid binding_id in ${project.path}`);
        }
      } catch (error) {
        issues.push(`Cannot read project.toml from ${project.path}`);
      }
    }
    
    return { valid: issues.length === 0, issues, warnings: [] };
  }
  
  private isValidBindingId(bindingId: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(bindingId);
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

- **Portable project identity consistency**: Always use `binding_id` from `.myco/project.toml` for project-scoped configuration rather than derived identifiers. The binding_id is stable across machine boundaries and clone operations.

- **Project.toml dependency**: Project-scoped configuration access requires a valid `.myco/project.toml` file. Always validate project.toml presence and binding_id format before attempting project configuration operations.

- **Legacy project ID migration**: When migrating from legacy project identifiers, preserve configuration continuity by mapping legacy values to binding_id-based storage before removing legacy entries.

- **Grove identity coordination**: Project configuration changes may affect Grove-level settings inheritance. Always consider the Grove/project relationship when modifying project-scoped configuration patterns.

- **Automatic migration side effects**: The automatic migration during `myco update` preserves values but changes their scope. Be aware that previously project-specific settings become grove-wide after migration. Review Grove config after update to ensure the migrated values are appropriate for all projects in the Grove.