# Advanced Harness Integration, Cost Models, Fault Tolerance and Session Lifecycle

Reference material for the `author-harness-task` skill.

# Procedure 8: Advanced Harness Integration

## Pi integration patterns

- Design agent implementations for central harness registry
- Use durable state contracts for reliable lifecycle management
- Implement proper agent scoping and resource cleanup
- Follow Pi conceptual framework for architecture consistency

## Harness-ready architecture

- Register in central harness for discoverability
- Use registry-based agent resolution for dynamic assignment
- Implement config caching patterns
- Design for minimal resource consumption during idle periods

# Procedure 9: Cost Models and Performance Optimization

## Cost-aware strategies

- Monitor token consumption patterns across iterations
- Implement circuit breakers for expensive operations
- Use consolidated provider metadata for model selection optimization
- Design adaptive pricing strategies with cost efficiency feedback

## Performance patterns

- **Agent instance pooling**: Reuse instances across iterations when safe
- **Tool surface optimization**: Strip unnecessary tools, implement lazy loading
- **Batch sizing strategies**: Balance memory, cost, and latency constraints
- **Resource monitoring**: Track memory/CPU usage, alert on exhaustion

# Procedure 10: Fault Tolerance and State Management

## Robust operation patterns

- Implement checkpoint/resume for large operations
- Design idempotent operations where possible
- Use failure isolation to contain iteration failures
- Preserve partial results for manual recovery

## State management

- Persist intermediate state at logical boundaries
- Enable resumption from last successful checkpoint
- Design state contracts that survive restarts
- Implement state validation and migration patterns

# Procedure 11: Session Lifecycle Orchestration for Tasks

## Cortex Instructions Requirement

The lead (top-level agent orchestrator) must establish Cortex instructions context before delegating work to sub-agents:

1. **Instructions acquisition**: Lead agent calls `myco_cortex({op:"instructions"})` BEFORE delegating to sub-agents
2. **Context propagation**: Pass acquired instructions through delegation chain via unified path
3. **Consistency validation**: Verify all delegates operating under same instruction set
4. **Sub-agent enforcement**: Sub-agents must fail if delegation proceeds without cortex-injection-context
5. **Unified injection path**: All task phases receive cortex context injected uniformly — lead establishes context once, all child phases inherit it

This prevents inconsistent or divergent behavior across the delegation hierarchy.

## Session initialization and validation

1. **Generate session ID**: Use deterministic UUID generation based on timestamp and project context
2. **Validate project binding**: Ensure session is created within valid project scope
3. **Initialize session record**: Create database entry with proper status (`active`)
4. **Set initial metadata**: Project ID, machine ID, agent context, creation timestamp
5. **Verify project root**: Session must be created within valid Myco project using `resolveVaultDir()`
6. **Check vault permissions**: Ensure write access to `.myco/` directory
7. **Validate agent identity**: Confirm agent has permission to create sessions in this project

## Hook transport and capture coordination

1. **Scan for installed agents**: Check agent-specific hook configurations in `.myco/`
2. **Validate hook implementations**: Check that hook files exist and are executable
3. **Cross-platform deployment**: Use `join(resolveMycoHome(), 'launcher.cjs')` for the cross-platform hook guard (`.agents/myco-run.cjs` was retired by the global-install migration)
4. **Transport protocol setup**: Configure capture channels based on agent type
5. **Scope validation**: Ensure captured content belongs to current project
6. **Permission checks**: Verify agent has capture rights for target files/directories
7. **Content filtering**: Apply exclusion rules for sensitive or irrelevant content
8. **Size limits**: Enforce capture size boundaries to prevent resource exhaustion

## Runtime boundary validation

1. **Error boundary enforcement**: Prevent task errors from affecting other sessions
2. **Resource protection**: Guard against resource exhaustion attacks
3. **Data validation**: Ensure captured content meets quality standards
4. **Permission enforcement**: Block unauthorized operations consistently
5. **Failure classification**: Categorize failures as transient, configuration, system, or agent-level for proper recovery
6. **Recovery procedures**: Implement session recovery, task restart, and data repair workflows

## Multi-agent coordination within sessions

1. **Concurrent execution management**: Manage multiple agents operating on same project
2. **Task serialization**: Sequence dependent operations to avoid conflicts
3. **Resource sharing**: Coordinate shared vault and database access
4. **Result synchronization**: Merge results from parallel agent operations
5. **Isolation setup**: Configure runtime boundaries between concurrent agents
