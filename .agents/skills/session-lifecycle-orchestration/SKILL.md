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
- Daemon startup coordination is complete (all subsystems initialized)

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

### Daemon Startup Coordination

1. **Subsystem initialization**: Ensure all daemon subsystems are fully loaded before session processing
2. **Service dependency**: Validate that intelligence processing services are ready
3. **Runtime boundary establishment**: Set up agent execution boundaries during daemon startup
4. **Health check coordination**: Verify all runtime components are operational

## Procedure D: Session Status Transitions and Lifecycle Management

### Refined Status Progression Model

The session lifecycle uses a three-phase progression model that prevents feedback loops between capture orchestration and intelligence processing:

1. **CAPTURING phase** (`active` status): Session is actively capturing content from agent interactions
   - All capture operations are valid and expected
   - Agent operations can modify session state and add new content
   - Session remains in this state until agent work is complete
   - Transitions to PROCESSING when agent finishes work and session is marked completed

2. **PROCESSING phase** (`completed` status): Session work is finished, intelligence processing begins
   - No new captures accepted - session is sealed for processing
   - Intelligence tasks (skill-survey, full-intelligence) can now safely process the session
   - Session data is stable and won't be modified by ongoing agent operations
   - Prevents feedback loops where intelligence tasks would process incomplete sessions
   - Transitions to COMPLETE after all intelligence processing finishes

3. **COMPLETE phase** (`processed` status): Intelligence extraction is complete, session is archived
   - Session is read-only for historical reference and lineage tracking
   - All derived spores and insights have been extracted and stored
   - Can be reopened for follow-up work if needed
   - Final state for most sessions in the system

### Session Gating for Intelligence Tasks

Intelligence processing tasks must gate on session-terminal state to prevent processing incomplete or actively-changing sessions:

1. **Session-terminal validation**: Intelligence tasks only process sessions with `completed` or `processed` status
2. **Active session exclusion**: Skip sessions with `active` status as they may still receive new content
3. **State transition coordination**: Ensure clean handoff from capture to processing phases
4. **Consistency guarantees**: Process only stable session content that won't change during analysis

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
- Always validate session status before operations - intelligence tasks must gate on session-terminal state (completed/processed) as active sessions produce stale artifacts and create feedback loops
- Never assume session data is immutable - agents can modify sessions during CAPTURING phase
- Use database transactions for multi-step status changes to ensure atomicity
- The refined CAPTURING → PROCESSING → COMPLETE model prevents intelligence tasks from processing incomplete sessions

### Cross-Platform Hook Deployment
- The `.agents/myco-run.cjs` guard handles OSS contributor safety across platforms
- MCP children inherit `cwd=/` from some agents - use `resolveVaultDir()` with `MYCO_VAULT_DIR` fallback
- Hook transport must handle both real-time capture and batch processing modes

### Runtime Resource Management
- Agent harness execution can consume significant resources - implement proper cleanup
- Concurrent sessions must coordinate vault database access to prevent corruption
- Local model agents need 3-4× the turn budget compared to cloud models
- Daemon startup coordination ensures all subsystems are ready before session processing begins

### Error Handling and Recovery
- Session lifecycle errors often cascade - isolate failures early to prevent spread
- Always preserve session lineage even during error recovery procedures
- Agent runtime boundaries are enforced in tool code, not prompts - implement deterministic checks
- Session gating prevents intelligence feedback loops by ensuring only stable sessions are processed