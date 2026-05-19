---
name: myco:platform-architecture-and-extraction
description: |
  Comprehensive procedures for platform architecture design and package extraction 
  methodology for multi-product deployment. Covers platform vision strategy, API 
  surface analysis, package boundary design, ownership separation, and phased 
  extraction implementation. Use this when architecting platform solutions, 
  extracting reusable packages, or designing multi-product architectures, even if 
  the user doesn't explicitly ask for platform extraction guidance.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Platform Architecture and Package Extraction

Platform extraction methodology for transforming single-product systems into reusable platform architectures that support multiple product surfaces. These procedures enable systematic package boundary design, ownership separation, and phased implementation strategies for institutional memory and intelligence systems.

## Prerequisites

- Existing working system with established API surfaces and domain boundaries
- Clear understanding of current product capabilities and future platform vision
- Access to system architecture documentation and codebase analysis tools
- Stakeholder alignment on multi-product platform strategy

## Procedure A: Platform Vision and Product Strategy

Define the dual-product platform vision and strategic framing before technical extraction.

**1. Establish Product Surface Distinction**
- **Current Product**: Identify existing product capabilities and user workflows
- **Platform Product**: Define future applications and integration scenarios
- Frame platform as reusable intelligence/memory runtime, not just a library
- Document core differentiator (e.g., harness, orchestration, custom intelligence)

**2. Validate Architectural Impact**
- Ensure current product becomes one client of the platform (not a wrapper)
- Verify future applications build on same core contracts and capabilities
- Identify shared runtime components vs. product-specific implementations
- Document platform value proposition beyond basic functionality

**Example for Myco Platform**:
```yaml
Current Product: "Myco to Build"
  - Coding agents, symbionts, code indexing, context injection
Platform Product: "Myco to Power"  
  - Applications using Myco as memory/intelligence runtime
Shared Core: Intelligence harness + orchestration contracts
```

**3. Strategic Validation Questions**
- Does the platform support genuinely different use cases, not just packaging variants?
- Is the harness/orchestration the differentiator, or just the data model?
- Can future products extend the platform without breaking current products?

## Procedure B: API Surface and Capability Analysis

Assess existing system capabilities to identify platform-ready surfaces and integration gaps.

**1. Inventory Existing API Surfaces**
- Catalog all current REST endpoints, RPC interfaces, and SDK surfaces
- Document authentication, authorization, and identity mechanisms
- Identify which surfaces already support application-class clients
- Map capability coverage: capture, processing, querying, orchestration

**2. Gap Analysis for Platform Requirements**
- **Identity and Scoping**: Current identity model vs. multi-tenant platform needs
- **Third-Party Integration**: Gaps between local-first and external app integration
- **Domain Event Schemas**: Explicit contracts for app-specific events and actions
- **SDK vs. Host Assumptions**: What assumes agent host vs. app client model

**3. Integration Architecture Planning**
- Determine app integration path: new SDK, extended REST API, or MCP extension
- Plan identity/auth evolution: local-first → scoped app identity
- Define event envelope and domain schema contracts
- Separate symbiont patterns from general app integration patterns

**Example Assessment**:
```typescript
// Platform-ready: General capture and query surfaces
POST /sessions/register
GET /api/search
POST /context/prompt

// Gap: App identity and scoping
// Current: x-myco-auth (local-only)
// Needed: App registration + scoped access

// Gap: App-specific events
// Current: Session/batch events only  
// Needed: Domain event contracts for app actions
```

## Procedure C: Package Boundary and Ownership Design

Establish clear ownership boundaries and package responsibilities for the target platform architecture.

**1. Core Platform Boundary Definition**
- **What the core OWNS**: Contracts, interfaces, and type definitions only
- **What the core EXCLUDES**: Implementations, SDKs, storage, UI, domain-specific logic
- Define harness and orchestration contracts as platform differentiator
- Establish provider/runtime abstraction boundaries

**2. Package Stack Architecture**
```
@org/platform-core              ← contracts only, zero implementation
         ↓
@org/platform-runtime           ← orchestration + runtime adapters  
         ↓
@org/platform-agent             ← default intelligence agent + tasks
         ↓
Current Product                 ← existing features + domain logic
Future Product                  ← app SDK + integration surfaces
```

**3. Ownership Separation Matrix**
- **Core Schema**: IDs, scopes, event envelopes, shared result shapes
- **Runtime Schema**: runs, phases, tool turns, reports, task state  
- **Product Schema**: domain-specific tables and business logic
- **Storage Interface**: Swappable backend contracts (not implementations)

**4. Dependency Validation Rules**
- Core has zero imports from products or implementations
- Runtime depends on core contracts only, not specific products
- Products depend on runtime, not each other
- No circular dependencies between packages

**Example Ownership Map**:
```yaml
Core Owns:
  - Identity and scope contracts
  - Event envelope definitions  
  - Tool/action metadata schemas
  - Harness interface contracts
  - Storage interface definitions

Core Does NOT Own:
  - Claude/OpenAI SDK implementations
  - Database queries or migrations
  - UI components or routing
  - Domain-specific business logic
  - Current task catalog implementations
```

## Procedure D: Phased Extraction Implementation

Execute package extraction using contract-first approach with import inversion.

**1. Phase 1: Contract Extraction + Import Inversion**
- Create core package scaffold with strict dependency rules
- Extract pure contract types (identity, memory, search, harness, orchestration)
- Invert imports so existing system depends on core contracts
- Add validation tests proving zero reverse dependencies
- Sketch future product contract types without full implementation

**2. Phase Validation Gates**
- **Success Criterion**: Next phases become obvious, not harder
- **Import Test**: Core package has zero imports from implementation packages
- **Contract Coverage**: All major domain boundaries have type definitions
- **Dependency Direction**: Products → Runtime → Core (never reversed)

**3. Implementation Extraction Strategy**  
- **Phase 2**: Extract runtime implementations (orchestration, execution)
- **Phase 3**: Extract agent implementations (tasks, prompts, state)
- **Phase 4**: Separate product-specific features and domains
- **Phase 5**: Add new product integrations using established patterns

**4. Refactoring Approach**
```typescript
// Before: Direct imports
import { processSession } from '../daemon/processor'

// After: Contract-based dependency injection  
import { SessionProcessor } from '@org/platform-core'
const processor: SessionProcessor = runtimeContainer.get('SessionProcessor')
```

**Phase 1 Checklist**:
- [ ] Core package created with contract types only
- [ ] Import direction validated: products → core (not core → products)  
- [ ] Zero implementation code in core package
- [ ] Contract coverage for major domain boundaries
- [ ] Tests proving package boundary isolation
- [ ] Architecture sketches for future phases

## Cross-Cutting Gotchas

**Contract Boundary Violations**
- **Issue**: Core package accidentally importing implementation details
- **Prevention**: Use TypeScript strict mode and dependency validation tools
- **Detection**: CI checks for import violations and package size growth

**Premature Optimization**  
- **Issue**: Trying to extract all packages in Phase 1
- **Prevention**: Focus on contracts and import inversion only in Phase 1
- **Rationale**: Wrong boundaries early create more refactoring work later

**Identity and Auth Complexity**
- **Issue**: Platform identity requirements conflicting with local-first model  
- **Approach**: Evolve authentication incrementally, don't break existing workflows
- **Strategy**: Start with local app registration, expand to external integration

**Domain Event Schema Evolution**
- **Issue**: Breaking changes to event contracts affecting multiple products
- **Prevention**: Version event schemas from initial platform extraction
- **Strategy**: Use envelope patterns with backward-compatible payload evolution

**Ownership Boundary Ambiguity**
- **Issue**: Unclear whether capability belongs in core, runtime, or product
- **Decision Framework**: If it's a contract/interface → core, if it's shared implementation → runtime, if it's product-specific → product package
- **Gray Areas**: Cross-cutting concerns like observability require explicit ownership decisions