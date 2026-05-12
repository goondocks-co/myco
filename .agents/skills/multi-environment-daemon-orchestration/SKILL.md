---
name: myco:multi-environment-daemon-orchestration
description: |
  Procedures for operating multiple daemon instances with proper isolation, 
  ownership enforcement, and boundary controls across development/production 
  environments. Covers Grove ownership enforcement, multi-environment service 
  directory coordination, scope-aware iteration, ownership gates, legacy scope 
  elimination, and multi-tenant daemon coordination. Use when setting up multiple 
  daemon instances, enforcing Grove ownership boundaries, or coordinating 
  development/production environments, even if the user doesn't explicitly ask 
  for multi-environment orchestration.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Multi-Environment Daemon Orchestration

Comprehensive procedures for operating multiple daemon instances with proper isolation, ownership enforcement, and boundary controls. This domain covers coordinating separate daemon environments (development vs production), implementing Grove ownership enforcement, and ensuring proper scope isolation to prevent cross-environment data corruption.

## Prerequisites

- Understanding of daemon architecture and Grove ownership model
- Access to both production (`~/.myco/service/`) and development (`~/.myco/service-dev/`) service directories
- Knowledge of `DaemonVariant` types and ownership validation patterns
- Familiarity with `forEachGrove` iteration patterns and `served_by` field architecture

## Procedure A: Grove Ownership Enforcement

Implement ownership filtering and validation to prevent cross-Grove mutations:

1. **Implement `forEachGrove` ownership filtering**:
   ```typescript
   // Add ownership validation to Grove iteration
   forEachGrove((grove) => {
     if (grove.served_by !== currentDaemonVariant) {
       return; // Skip groves not owned by this daemon
     }
     // Proceed with grove operations
   });
   ```

2. **Validate `served_by` field architecture**:
   - Ensure every Grove has a `served_by` field matching its daemon variant (`'service'` or `'service-dev'`)
   - Validate variant consistency during Grove loading
   - Reject operations on Groves with mismatched ownership

3. **Implement scope-aware iteration patterns**:
   - Filter Grove collections by ownership before iteration
   - Add ownership assertions at critical operation entry points
   - Prevent shared code paths from operating outside assigned scope

## Procedure B: Multi-Environment Service Directory Isolation

Coordinate separate service directories with mutual eviction prevention:

1. **Set up environment-specific service directories**:
   - Production: `~/.myco/service/` (default daemon variant `'service'`)
   - Development: `~/.myco/service-dev/` (dogfood daemon variant `'service-dev'`)
   - Ensure path-based daemon identification using `resolveServiceDirName()`

2. **Implement mutual eviction prevention**:
   - Check for existing daemon processes before starting
   - Use environment-specific lock files
   - Prevent binding conflicts between daemon variants

3. **Coordinate daemon startup sequences**:
   - Validate service directory ownership before startup using `daemonVariant(daemonStateDir)`
   - Implement graceful handoff between environment switches
   - Ensure proper cleanup of environment-specific resources

## Procedure C: Scope-Aware Daemon Operations

Implement daemon-scope-aware operations that respect ownership boundaries:

1. **Add scope validation to critical operations**:
   ```typescript
   async function resolveAfterRepair(grove: Grove) {
     // Add ownership gate
     const currentVariant = daemonVariant(daemonStateDir);
     if (grove.served_by !== currentVariant) {
       throw new Error(`Cannot repair grove ${grove.id}: owned by ${grove.served_by}, not ${currentVariant}`);
     }
     // Proceed with repair operation
   }
   ```

2. **Implement ownership gates in shared code paths**:
   - Add ownership checks to vault mutation operations in `packages/myco/src/db/client.ts`
   - Validate scope before database writes using `validateOwnership()`
   - Prevent dogfood daemons from mutating production vaults

3. **Filter operations by daemon variant**:
   - Scope all Grove iteration to owned collections in `packages/myco/src/daemon/scope-iteration.ts`
   - Add variant-aware query filters in API endpoints
   - Implement ownership-based operation routing

## Procedure D: Legacy Scope Elimination and Connection Cleanup

Remove legacy scope patterns and prevent ownership bypass:

1. **Eliminate legacy connection scope patterns**:
   ```typescript
   // Clean up legacy-project connection scopes in team-connect.ts
   type ConnectionScope = 'grove'; // Remove 'legacy-project' variant
   
   // Add validation to prevent legacy fallbacks
   function validateConnectionScope(scope: string): ConnectionScope {
     if (scope === 'legacy-project') {
       throw new Error('Legacy connection scope no longer supported');
     }
     return scope as ConnectionScope;
   }
   ```

2. **Prevent silent fallbacks in request routing**:
   - Remove legacy-project fallbacks in `packages/myco/src/tools/request-context.ts`
   - Add explicit Grove scoping requirements to daemon initialization
   - Validate scope consistency across daemon operations

3. **Implement systematic ownership checks**:
   - Add ownership validation to all Grove access points in `packages/myco/src/daemon/api/groves.ts`
   - Implement ownership assertion utilities for consistent validation
   - Create ownership validation test suite

## Procedure E: Multi-Tenant Daemon Coordination

Coordinate multiple daemon instances with isolation guarantees and cross-project query leak prevention:

1. **Implement inter-daemon communication protocols**:
   - Use variant-specific service directories for coordination
   - Implement daemon discovery and registration using Grove manifests
   - Add coordination for shared resource access via claim/release operations

2. **Ensure isolation guarantees with request context propagation**:
   - Validate Grove ownership before any mutation using `validateOwnership()`
   - **Thread request context through all database query paths** to prevent cross-project data leakage
   - Add isolation verification tests using `isProjectActive()` checks
   - Implement request context validation at database query entry points

3. **Prevent multi-tenancy query leaks**:
   ```typescript
   // Add request context to all database operations
   async function queryWithProjectScoping(query: string, params: any[], requestContext: MycoRequestContext) {
     // Ensure project_id is always included in queries
     const projectId = rowProjectIdFromRequestContext(requestContext);
     const scopedQuery = `${query} AND project_id = ?`;
     const scopedParams = [...params, projectId];
     
     return await db.all(scopedQuery, scopedParams);
   }
   
   // Validate request context propagation in daemon operations
   function validateRequestContextPropagation(operation: string, context: MycoRequestContext) {
     if (!context || !context.projectId) {
       throw new Error(`Request context missing for operation ${operation} - potential cross-project data leak`);
     }
   }
   ```

4. **Coordinate daemon lifecycle events**:
   - Implement graceful shutdown with environment cleanup
   - Handle daemon restart scenarios with ownership validation
   - Ensure proper resource cleanup on daemon termination using `forEachGrove` cleanup patterns

## Cross-Cutting Gotchas

- **Always validate Grove ownership** before any mutation operation - shared code paths can easily bypass scope boundaries
- **Service directory isolation** requires careful path management - ensure environment-specific directories are properly isolated using `SERVICE_DEV_DIRNAME` constant
- **Legacy scope elimination** must be systematic - any remaining `'legacy-project'` references in connection scopes can create ownership bypass vulnerabilities
- **Daemon variant coordination** between environments prevents binding conflicts but requires careful startup sequencing
- **Ownership validation performance** - cache ownership checks for frequently accessed Groves to avoid performance degradation in `forEachGrove` iterations
- **Request context propagation gaps** - any database query path without request context creates potential cross-project data leakage in multi-tenant environments. All DB operations must validate and include project scoping to prevent query leaks across project boundaries