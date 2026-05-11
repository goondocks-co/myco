---
name: myco:security-authorization-infrastructure
description: |
  Comprehensive procedures for implementing and maintaining security across
  Myco's multi-tenant architecture. Covers multi-tenant request context validation,
  file permission hardening, Grove isolation boundary enforcement, path validation
  for filesystem operations, and timing-safe authentication comparisons. Apply these
  procedures when implementing new security features, hardening existing authentication
  flows, or addressing security vulnerabilities in multi-tenant systems.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Security and Authorization Infrastructure

Myco's Grove multi-tenant architecture requires consistent security patterns across authentication, authorization, and data isolation. These procedures ensure secure request processing, proper file permissions, tenant isolation, and timing-safe comparisons to prevent common security vulnerabilities in the global daemon architecture.

## Prerequisites

- Understanding of Myco's Grove multi-tenant architecture
- Access to Grove-scoped project `.myco/` directory for secrets management
- Familiarity with Node.js security patterns and timing attack vectors
- Knowledge of filesystem permission models (Unix-style permissions)
- Understanding of Grove registration, binding patterns, and multi-project boundaries

## Procedure A: Multi-Tenant Request Context Validation

Implement secure authentication header processing and Grove ID validation for the global daemon architecture.

1. **Extract and validate Grove authentication headers:**
   ```javascript
   // Extract x-myco-* headers with strict validation for Grove context
   const groveId = req.headers['x-myco-grove-id'];
   const projectId = req.headers['x-myco-project-id'];
   const bearerToken = req.headers['authorization']?.replace('Bearer ', '');
   
   if (!groveId || !projectId || !bearerToken) {
     return res.status(401).json({ error: 'Missing authentication headers' });
   }
   
   // Validate Grove ID format (prevent injection)
   if (!/^grove_[0-9a-f]{32}$/.test(groveId)) {
     return res.status(400).json({ error: 'Invalid Grove ID format' });
   }
   
   // Validate project ID format
   if (!/^proj_[0-9a-f]{32}$/.test(projectId)) {
     return res.status(400).json({ error: 'Invalid Project ID format' });
   }
   ```

2. **Establish Grove-scoped request context boundaries:**
   ```javascript
   // Create isolated request context with Grove and project scope
   const requestContext = {
     groveId,
     projectId,
     userId: null,  // Set after token validation
     permissions: [],
     isolationLevel: 'grove',
     binding: null  // Set after Grove binding validation
   };
   
   // Thread context through middleware chain
   req.context = Object.freeze(requestContext);
   ```

3. **Validate Grove registration and project binding:**
   ```javascript
   // Verify Grove is registered and project exists within Grove
   const grove = await getGroveById(groveId);
   if (!grove || grove.status !== 'active') {
     return res.status(403).json({ error: 'Grove not found or inactive' });
   }
   
   const project = await getProjectInGrove(groveId, projectId);
   if (!project) {
     return res.status(403).json({ error: 'Project not found in Grove' });
   }
   
   req.context.binding = grove.binding_id;
   ```

4. **Handle Grove context validation errors:**
   - Return consistent error responses (avoid information leakage)
   - Log failed validation attempts with Grove/Project ID and timestamp
   - Implement rate limiting for repeated Grove validation failures
   - Track cross-Grove access attempts for security monitoring

## Procedure B: File Permission Hardening

Secure sensitive configuration files and implement proper gitignore patterns within Grove project boundaries.

1. **Secure Grove-scoped secrets.env file permissions:**
   ```bash
   # Set restrictive permissions on Grove project secrets file
   chmod 0o600 .myco/secrets.env
   
   # Verify permissions across all projects in Grove
   find ~/.myco/groves/grove_*/projects/*/. myco/ -name "secrets.env" -exec ls -la {} \;
   ```

2. **Update gitignore patterns for Grove-sensitive files:**
   ```gitignore
   # Add to .gitignore for Grove multi-project architecture
   .myco/secrets.env
   .myco/vault.db
   .myco/vault.db-*
   .myco/grove.toml
   ~/.myco/groves/
   *.pem
   *.key
   auth-tokens.json
   grove-binding.json
   ```

3. **Validate secure Grove configuration storage:**
   ```javascript
   // Check file exists and has correct permissions within Grove context
   const fs = require('fs');
   const path = require('path');
   
   const groveProjectRoot = getGroveProjectPath(req.context.groveId, req.context.projectId);
   const secretsPath = path.join(groveProjectRoot, '.myco', 'secrets.env');
   
   if (!fs.existsSync(secretsPath)) {
     throw new Error('Grove project secrets file not found');
   }
   
   const stats = fs.statSync(secretsPath);
   
   // Verify permissions (0o600 = 384 decimal)
   if ((stats.mode & 0o777) !== 0o600) {
     throw new Error('Insecure permissions on Grove project secrets.env');
   }
   ```

4. **Secure Grove configuration loading:**
   - Never log sensitive Grove-scoped configuration values
   - Use environment variable defaults with secure Grove-scoped fallbacks
   - Validate configuration values before use (type checking, format validation)
   - Ensure Grove isolation during configuration access

## Procedure C: Grove Isolation Boundary Enforcement

Ensure proper tenant isolation and prevent cross-Grove data access in the global daemon architecture.

1. **Implement Grove-scoped data access controls:**
   ```javascript
   // Prefix database queries with Grove and Project ID
   async function getGroveProjectData(groveId, projectId, resourceId) {
     // Always scope queries to the requesting Grove and project
     const query = `
       SELECT * FROM resources 
       WHERE grove_id = ? AND project_id = ? AND resource_id = ?
     `;
     return db.query(query, [groveId, projectId, resourceId]);
   }
   ```

2. **Validate cross-Grove operation attempts:**
   ```javascript
   // Check if operation crosses Grove or project boundaries
   function validateGroveProjectAccess(requestGrove, requestProject, targetGrove, targetProject) {
     if (requestGrove !== targetGrove) {
       throw new Error(`Cross-Grove access denied: ${requestGrove} -> ${targetGrove}`);
     }
     if (requestProject !== targetProject) {
       throw new Error(`Cross-project access denied: ${requestProject} -> ${targetProject}`);
     }
   }
   ```

3. **Implement Grove registration isolation verification:**
   ```javascript
   // Verify Grove binding and registration status
   async function validateGroveBinding(groveId, bindingId) {
     const grove = await getGroveRegistration(groveId);
     if (!grove || grove.binding_id !== bindingId) {
       throw new Error('Grove binding validation failed');
     }
     
     if (grove.status !== 'active') {
       throw new Error('Grove registration inactive');
     }
   }
   ```

4. **Handle Grove isolation violations:**
   - Log all cross-Grove access attempts with full context including binding IDs
   - Implement automatic Grove access revocation for repeated violations
   - Generate alerts for security team review with Grove registration details
   - Track Grove binding changes for audit purposes

## Procedure D: Path Validation for Filesystem Operations

Prevent directory traversal and implement secure file resolution within Grove project boundaries.

1. **Sanitize user-provided paths within Grove context:**
   ```javascript
   const path = require('path');
   
   function sanitizeGrovePath(userPath, groveId, projectId) {
     // Get Grove project base directory
     const groveProjectRoot = getGroveProjectPath(groveId, projectId);
     
     // Resolve relative paths and check Grove boundaries
     const resolvedPath = path.resolve(groveProjectRoot, userPath);
     const normalizedBase = path.resolve(groveProjectRoot);
     
     // Ensure resolved path is within Grove project directory
     if (!resolvedPath.startsWith(normalizedBase + path.sep)) {
       throw new Error('Grove path traversal attempt detected');
     }
     
     return resolvedPath;
   }
   ```

2. **Implement secure Grove project file resolution patterns:**
   ```javascript
   // Safe file operations within Grove project boundaries
   function safeGroveFileOperation(relativePath, groveId, projectId, operation) {
     const groveProjectRoot = getGroveProjectPath(groveId, projectId);
     const safePath = sanitizeGrovePath(relativePath, groveId, projectId);
     
     // Additional checks for Grove-sensitive directories
     const sensitivePatterns = [
       '.myco/secrets', 
       '.myco/grove.toml',
       '.git', 
       'node_modules',
       '../' // Prevent any parent directory access
     ];
     
     for (const pattern of sensitivePatterns) {
       if (safePath.includes(pattern)) {
         throw new Error(`Access denied to Grove-sensitive path: ${pattern}`);
       }
     }
     
     return operation(safePath);
   }
   ```

3. **Validate Grove project file access permissions:**
   - Check file permissions before read/write operations within Grove context
   - Verify user has necessary access rights for the Grove project operation
   - Log file access attempts for Grove audit purposes
   - Validate Grove registration status before file operations

4. **Handle Grove path validation errors:**
   - Return generic error messages (avoid Grove path disclosure)
   - Log detailed error information for Grove security monitoring
   - Implement rate limiting for repeated invalid Grove path attempts
   - Track Grove boundary violation patterns

## Procedure E: Timing-Safe Authentication Comparisons

Implement constant-time comparisons to prevent timing oracle attacks in Grove authentication.

1. **Use timing-safe string comparison for Grove tokens:**
   ```javascript
   const crypto = require('crypto');
   
   function timingSafeEqual(a, b) {
     // Ensure strings are same length (pad if necessary)
     const maxLength = Math.max(a.length, b.length);
     const normalizedA = a.padEnd(maxLength, '\0');
     const normalizedB = b.padEnd(maxLength, '\0');
     
     // Use Node.js built-in timing-safe comparison
     return crypto.timingSafeEqual(
       Buffer.from(normalizedA, 'utf8'),
       Buffer.from(normalizedB, 'utf8')
     );
   }
   ```

2. **Implement Grove bearer token validation:**
   ```javascript
   async function validateGroveBearerToken(providedToken, groveId, projectId) {
     // Get expected token for Grove/project combination
     const expectedToken = await getGroveProjectToken(groveId, projectId);
     
     // Always perform full validation even if obviously invalid
     const isValid = timingSafeEqual(providedToken || '', expectedToken);
     
     // Add consistent delay to prevent timing analysis
     const minDelay = 10; // milliseconds
     await new Promise(resolve => setTimeout(resolve, minDelay));
     
     return isValid;
   }
   ```

3. **Prevent Grove oracle attack vectors:**
   - Always compare full token lengths (avoid early returns)
   - Implement consistent response times for valid/invalid Grove tokens
   - Use cryptographically secure random tokens with sufficient entropy
   - Validate Grove binding IDs using constant-time comparisons

4. **Audit timing-sensitive Grove operations:**
   - Review all Grove authentication and authorization code for timing leaks
   - Use security testing tools to detect timing oracle vulnerabilities
   - Implement monitoring for unusual Grove authentication timing patterns
   - Track Grove binding validation timing consistency

## Cross-Cutting Gotchas

**Grove secret file permissions reset:** File permissions on Grove-scoped `.myco/secrets.env` can be reset by git operations or deployment scripts. Always verify permissions after deployment and include Grove-scoped permission checks in startup validation.

**Grove ID case sensitivity:** Grove IDs are case-sensitive in the database but may be normalized differently in headers. Always use consistent casing (lowercase) and validate format before database operations across all Grove contexts.

**Path traversal in Grove project imports:** Node.js `require()` statements with relative paths can be exploited for directory traversal across Grove boundaries. Use absolute paths or validated relative paths for dynamic imports within Grove projects.

**Timing attack via Grove error messages:** Different error messages for "Grove not found" vs "invalid Grove token" can leak timing information. Use generic error messages and consistent processing times for all Grove authentication failures.

**Cross-Grove session pollution:** Session storage can accidentally leak data between Groves if session keys don't include Grove and Project IDs. Always prefix session keys with both Grove ID and Project ID to ensure proper isolation.

**Grove binding validation bypass:** Grove binding IDs must be validated against the Grove registration table, not just the request headers. Attackers may attempt to spoof binding IDs to bypass Grove isolation boundaries.

**Grove registration state races:** Grove registration status can change during request processing. Always re-validate Grove registration status before performing sensitive operations, especially file system access.