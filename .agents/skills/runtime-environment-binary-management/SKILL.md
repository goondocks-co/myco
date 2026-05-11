---
name: myco:runtime-environment-binary-management
description: |
  Procedures for managing binary dispatch, runtime environment resolution, and machine-scoped coordination in Myco deployments. Covers layered runtime command resolution (~/.myco/runtime.command pins, project overrides, fallback chains), machine-scoped runtime architecture, binary masquerade detection and prevention, update coordination protocols, and Bun compilation deployment patterns. Use when setting up environments, troubleshooting binary dispatch issues, managing machine-scoped coordination, or implementing system updates, even if the user doesn't explicitly ask for runtime environment management.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Runtime Environment and Binary Management

Comprehensive procedures for managing Myco's binary dispatch system, runtime environment resolution, and machine-scoped coordination. These procedures ensure reliable binary execution, prevent environment conflicts, and maintain proper isolation across different deployment contexts in the Grove multi-project daemon architecture.

## Prerequisites

- Myco installation with proper symbiont structure
- Understanding of Myco's Grove multi-project daemon architecture (packages/myco/src/daemon/)
- Access to runtime configuration files (~/.myco/runtime.command, project-level configs)
- Familiarity with Bun compilation and single-file binary patterns
- Knowledge of Grove registration and project binding patterns

## Procedure A: Runtime Command Resolution and Fallback Management

Configure and debug the layered runtime command resolution system with Grove multi-project support.

### Machine-Wide Runtime Pins

1. **Check machine-wide runtime pin**:
   ```bash
   cat ~/.myco/runtime.command
   ```

2. **Set machine-wide pin** (when needed for consistent binary dispatch across all Groves):
   ```bash
   echo "/path/to/preferred/myco/binary" > ~/.myco/runtime.command
   ```

3. **Validate pin target** (ensure the pinned binary exists and is executable):
   ```bash
   ls -la $(cat ~/.myco/runtime.command)
   ```

### Project-Level Override Patterns

1. **Check project-level runtime configuration**:
   ```bash
   # Look for project-specific runtime overrides
   find .myco/ -name "runtime.command" -o -name "*.runtime.conf"
   ```

2. **Implement project override** (when project needs specific binary version):
   ```bash
   # Project-level pin takes precedence over machine-wide
   echo "/project/specific/myco/binary" > .myco/runtime.command
   ```

### Fallback Chain Validation

1. **Test fallback chain resolution**:
   ```bash
   # Verify binary resolution order: project → machine → PATH
   which myco
   echo $PATH | tr ':' '\n' | grep myco
   ```

2. **Debug resolution failures**:
   ```bash
   # Check each step of the fallback chain
   [ -f .myco/runtime.command ] && echo "Project pin: $(cat .myco/runtime.command)"
   [ -f ~/.myco/runtime.command ] && echo "Machine pin: $(cat ~/.myco/runtime.command)"
   which myco || echo "No myco in PATH"
   ```

## Procedure B: Machine-Scoped Runtime Architecture

Manage machine-scoped service coordination and runtime environment resolution in the Grove multi-project architecture.

### Grove Global Daemon Runtime Resolution

1. **Check Grove daemon runtime source status**:
   ```bash
   # Check daemon runtime source via API (Grove global daemon)
   curl -s http://127.0.0.1:20915/api/stats | jq '.runtime'
   ```

2. **Verify machine-scoped configuration with Grove support**:
   ```bash
   # Validate machine-level runtime settings for multi-Grove operation
   ls -la ~/.myco/runtime.command
   myco doctor # Should report runtime source information for all Groves
   ```

### Multi-Project Grove Coordination

1. **Test cross-Grove runtime consistency**:
   ```bash
   # Verify that machine runtime applies across all registered Groves
   myco groves list # List all registered Groves
   cd /path/to/grove1/project1
   myco --version
   cd /path/to/grove2/project2  
   myco --version # Should show same binary unless project-pinned
   ```

2. **Manage multi-Grove updates**:
   ```bash
   # Update all Groves via machine-scoped coordination
   myco update --all-groves
   ```

### Grove Registration Impact on Runtime Resolution

1. **Validate runtime resolution after Grove registration**:
   ```bash
   # Check that newly registered Groves use correct runtime
   myco grove register /path/to/new/grove
   cd /path/to/new/grove/project
   myco --version # Should match machine-wide runtime
   ```

## Procedure C: Binary Masquerade Detection and Prevention

Detect and prevent binary dispatch conflicts between published and development versions across Grove boundaries.

### Version Detection Reliability

1. **Verify binary authenticity across Groves**:
   ```bash
   # Check binary version and source for all Groves
   myco --version
   which myco
   file $(which myco) # Check if it's a compiled binary or script
   ```

2. **Detect masquerade scenarios**:
   ```bash
   # Compare expected vs actual binary paths
   realpath $(which myco)
   # Check for unexpected symlinks or wrappers
   ls -la $(dirname $(which myco))/myco*
   ```

### Re-exec Logic Validation

1. **Test binary re-execution**:
   ```bash
   # Verify that runtime.command pins work correctly
   strace -e execve myco --version 2>&1 | grep execve
   ```

2. **Validate update mechanisms**:
   ```bash
   # Check that updates don't break re-exec logic
   myco doctor # Should report consistent binary paths
   ```

## Procedure D: Update Coordination and Environment Management

Coordinate binary updates and environment transitions without disrupting active workflows across multiple Groves.

### Upgrade Path Testing

1. **Test upgrade in isolation**:
   ```bash
   # Create temporary environment for testing
   cp ~/.myco/runtime.command ~/.myco/runtime.command.backup
   echo "/path/to/new/binary" > ~/.myco/runtime.command
   myco --version # Verify new binary works
   ```

2. **Rollback on failure**:
   ```bash
   # Restore previous configuration if upgrade fails
   mv ~/.myco/runtime.command.backup ~/.myco/runtime.command
   ```

### NPM Package Upgrade Handling

1. **Handle Grove daemon binary version mismatches**:
   ```bash
   # After npm install -g @goondocks/myco@latest
   myco doctor # Check for version mismatches
   # Restart Grove global daemon if versions don't match
   myco daemon stop
   myco daemon start
   ```

2. **Validate Grove daemon restart after package updates**:
   ```bash
   # Ensure Grove daemon serves JSON, not HTML after updates
   curl -s http://127.0.0.1:20915/api/stats
   # Should return JSON, not HTML error page
   # Verify all registered Groves are accessible
   myco groves list
   ```

### Binary Replacement Procedures

1. **Atomic binary replacement**:
   ```bash
   # Replace binary atomically to avoid partial updates
   mv /new/myco/binary /usr/local/bin/myco.new
   mv /usr/local/bin/myco.new /usr/local/bin/myco
   ```

2. **Validate replacement across Grove boundaries**:
   ```bash
   # Ensure new binary works across all Groves
   myco doctor
   ps aux | grep myco # Check running Grove daemon still works
   myco groves list # Verify all Groves remain accessible
   ```

## Procedure E: Bun Compilation and Deployment

Handle Bun-specific compilation constraints and deployment patterns for Grove multi-project architecture.

### Single-File Binary Constraints

1. **Validate Bun compilation output**:
   ```bash
   # Check compiled binary structure using build scripts
   cd packages/myco
   node scripts/build-all-targets.mjs
   file ./dist/myco-*
   ldd ./dist/myco-* 2>/dev/null || echo "Static binaries (expected)"
   ```

2. **Test asset bundling**:
   ```bash
   # Verify required assets are bundled
   strings ./dist/myco-linux | grep -E "\.(json|sql|md)$" | head -10
   ```

### Multi-Target Compilation

1. **Build for different platforms**:
   ```bash
   # Use the established build script for multi-target compilation
   make build # Uses bun build --compile for all targets
   ls -la ./dist/myco-*
   ```

2. **Validate cross-platform deployment**:
   ```bash
   # Test that each binary works on its target platform
   file ./dist/myco-* 
   # Deploy with platform-specific runtime.command pins
   ```

## Cross-Cutting Gotchas

**Runtime command masquerade**: Machine-wide pins in `~/.myco/runtime.command` can mask local development binaries. Always check `which myco` vs pinned path when debugging unexpected behavior across multiple Groves.

**NPM package upgrade stale Grove daemon**: After `npm install -g @goondocks/myco@latest`, the Grove global daemon may continue running with the old binary, causing context-switch requests to serve HTML instead of JSON. Always restart the Grove daemon after package upgrades.

**Binary replacement during active sessions**: Replacing binaries while Grove daemon processes are running can cause undefined behavior across all registered Groves. Stop all myco processes before binary updates.

**Bun asset bundling gaps**: Not all file types are automatically detected for bundling. Use the established build scripts in `packages/myco/scripts/` to ensure proper asset inclusion in single-file outputs.

**Update coordination race conditions**: Multiple processes trying to update runtime.command simultaneously can corrupt the file. Use atomic writes (write to temp file, then rename) for runtime configuration changes.

**Machine-scoped runtime persistence**: The runtime.command file has been moved from project-scoped (`.myco/runtime.command`) to machine-scoped (`~/.myco/runtime.command`). Procedures must account for this architectural change when managing multi-Grove environments.

**Grove registration runtime inheritance**: When registering new Groves, they inherit the machine-wide runtime configuration. Ensure the machine-wide runtime.command is properly set before Grove registration to avoid runtime resolution issues.