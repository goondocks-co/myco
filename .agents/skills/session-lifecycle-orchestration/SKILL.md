---
name: myco:session-lifecycle-orchestration
description: |
  Comprehensive procedures for managing Myco session lifecycle from creation through intelligence processing and agent runtime orchestration. Covers session initialization with project scoping, hook transport and capture coordination, agent harness abstraction and pluggable runtime systems, status transitions and lifecycle management, and runtime boundary validation with error classification. Use this skill when creating new sessions, coordinating agent execution, managing session state transitions, debugging runtime issues, or implementing new agent types, even if the user doesn't explicitly ask for session lifecycle management.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Session Lifecycle and Agent Runtime Orchestration

This skill covers the complete operational domain of session management and agent runtime coordination in Myco. Sessions are the fundamental unit of work - every agent interaction, intelligence processing task, and capture operation happens within a session context. Proper lifecycle management ensures data integrity, runtime isolation, and reliable coordination across the agent pipeline.

## Prerequisites

- Myco vault is initialized (`.myco/` directory exists)
- Agent daemon is running (`myco daemon start`)
- Project configuration is valid (`myco.yaml` exists and is well-formed)
- Database schema is current (no pending migrations)
- Agent symbionts are properly installed and registered

## Procedure A: Session Creation and Project Scoping

### Initial Session Setup

1. **Generate session ID**: Use deterministic UUID generation based on timestamp and project context
2. **Validate project binding**: Ensure session is created within valid project scope
   ```bash
   # Check project root and setup health
   myco doctor
   ```
3. **Initialize session record**: Create database entry with proper status (`active`)
4. **Set initial metadata**: Project ID, machine ID, agent context, creation timestamp

### Project Scoping Validation

1. **Verify project root**: Session must be created within a valid Myco project using `resolveVaultDir()`
2. **Check vault permissions**: Ensure write access to `.myco/` directory
3. **Validate agent identity**: Confirm agent has permission to create sessions in this project
4. **Set capture boundaries**: Define what content can be captured in this session scope

### Identity and Context Setup

1. **Machine identity**: Link session to current machine ID for provenance tracking
2. **Agent context**: Record which agent/tool initiated the session
3. **Project lineage**: Connect to parent project for team sync scenarios
4. **Capability flags**: Set what operations this session can perform

## Procedure B: Hook Transport and Capture Coordination

### Hook Registry Management

1. **Scan for installed agents**: Check agent-specific hook configurations in `.myco/` 
2. **Validate hook implementations**: Check that hook files exist and are executable
3. **Cross-platform deployment**: Use `.agents/myco-run.cjs` for cross-platform hook guard
4. **Transport protocol setup**: Configure capture channels based on agent type

### Capture Boundary Validation

1. **Scope validation**: Ensure captured content belongs to current project
2. **Permission checks**: Verify agent has capture rights for target files/directories
3. **Content filtering**: Apply exclusion rules for sensitive or irrelevant content
4. **Size limits**: Enforce capture size boundaries to prevent resource exhaustion

### Coordination Patterns

1. **Async capture queuing**: Buffer captured content for batch processing
2. **Transport reliability**: Implement retry logic for failed capture operations
3. **Conflict resolution**: Handle concurrent captures from multiple agents
4. **Cleanup procedures**: Remove stale capture artifacts on session completion

## Procedure C: Agent Harness Abstraction and Runtime Coordination

### Harness Registry Patterns

1. **Runtime discovery**: Scan for available agent harnesses in `.agents/` directory
2. **Capability matching**: Match task requirements to harness capabilities
3. **Resource allocation**: Reserve compute and memory resources for agent execution
4. **Isolation setup**: Configure runtime boundaries between concurrent agents

### Pluggable Runtime System

1. **Runtime selection**: Choose appropriate harness based on task type and agent
2. **Environment preparation**: Set up execution environment with proper context
3. **Task delegation**: Route tasks to appropriate harness with session context
4. **Result aggregation**: Collect and validate results from harness execution

### Boundary Enforcement

1. **Read-only validation**: Enforce read-only constraints where applicable
2. **Tool access control**: Limit tool availability based on session permissions
3. **Resource limits**: Enforce CPU, memory, and time boundaries
4. **Error containment**: Isolate failures to prevent cascade effects

### Multi-Agent Coordination

1. **Concurrent execution**: Manage multiple agents operating on same project
2. **Task serialization**: Sequence dependent operations to avoid conflicts
3. **Resource sharing**: Coordinate shared vault and database access
4. **Result synchronization**: Merge results from parallel agent operations

## Procedure D: Session Status Transitions and Lifecycle Management

### Status Progression Patterns

1. **Active phase**: Session is accepting new operations and capturing content
   - All capture operations are valid
   - Agent operations can modify session state
   - Transitions to `completed` when agent finishes work

2. **Completed phase**: Session work is finished, ready for intelligence processing
   - No new captures accepted
   - Session is queued for intelligence tasks
   - Transitions to `processed` after intelligence runs

3. **Processed phase**: Intelligence extraction is complete, session is archived
   - Session is read-only for historical reference
   - Can be reopened for follow-up work if needed
   - Final state for most sessions

### Transition Validation

1. **Dependency checking**: Ensure all prerequisites are met before status change
2. **Data integrity**: Validate session data is consistent before transition
3. **Cleanup preparation**: Queue cleanup tasks for completed sessions
4. **Notification dispatch**: Send status change notifications to interested parties

### Lifecycle Management

1. **Session archival**: Move old processed sessions to archive storage
2. **Cleanup scheduling**: Remove temporary files and clear caches
3. **Lineage preservation**: Maintain provenance links even after archival
4. **Recovery procedures**: Handle incomplete transitions and corrupted state

## Procedure E: Runtime Boundary Validation and Error Classification

### Error Boundary Enforcement

1. **Agent isolation**: Prevent agent errors from affecting other sessions
2. **Resource protection**: Guard against resource exhaustion attacks
3. **Data validation**: Ensure captured content meets quality standards
4. **Permission enforcement**: Block unauthorized operations consistently

### Failure Classification Patterns

1. **Transient failures**: Network issues, temporary resource constraints
   - Implement exponential backoff retry logic
   - Log for monitoring but don't escalate immediately
   
2. **Configuration errors**: Invalid agent setup, missing permissions
   - Surface to user with actionable error messages
   - Provide diagnostic commands for resolution

3. **System failures**: Database corruption, filesystem issues
   - Escalate to system administrators
   - Trigger emergency backup procedures

4. **Agent failures**: Bug in agent code, unexpected behavior
   - Isolate failing agent to prevent cascade
   - Capture diagnostic information for debugging

### Recovery Procedures

1. **Session recovery**: Restore sessions from inconsistent state
2. **Agent restart**: Clean restart of failed agent harnesses  
3. **Data repair**: Fix corrupted session or capture data
4. **Manual intervention**: Escalation paths for unrecoverable errors

### Diagnostic Collection

1. **Error logging**: Structured error collection with context
2. **Performance metrics**: Track session timing and resource usage
3. **Agent telemetry**: Monitor agent health and operation success
4. **User experience tracking**: Measure end-to-end operation success

## Cross-Cutting Gotchas

### Session State Consistency
- Always validate session status before operations - intelligence tasks must gate on session-terminal state as active sessions produce stale artifacts
- Never assume session data is immutable - agents can modify sessions even after completion
- Use database transactions for multi-step status changes to ensure atomicity

### Cross-Platform Hook Deployment
- The `.agents/myco-run.cjs` guard handles OSS contributor safety across platforms
- MCP children inherit `cwd=/` from some agents - use `resolveVaultDir()` with `MYCO_VAULT_DIR` fallback
- Hook transport must handle both real-time capture and batch processing modes

### Runtime Resource Management
- Agent harness execution can consume significant resources - implement proper cleanup
- Concurrent sessions must coordinate vault database access to prevent corruption
- Local model agents need 3-4× the turn budget compared to cloud models

### Error Handling and Recovery
- Session lifecycle errors often cascade - isolate failures early to prevent spread
- Always preserve session lineage even during error recovery procedures
- Agent runtime boundaries are enforced in tool code, not prompts - implement deterministic checks