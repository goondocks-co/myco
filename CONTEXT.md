# Myco

Myco connects project activity to durable collective intelligence. Its domain separates machine-side participation from the server authority that owns project knowledge.

## Deployment and participation

**Member Installation**:
The machine-side Myco boundary that participates in one or more projects and connects them to a Myco Server. It owns no vault or user interface.
_Avoid_: Local Myco, local server

**Member Service**:
The resident part of a Member Installation on a long-lived developer machine. It maintains symbiont health and reconciles all Myco-managed global assets and locally registered Projects to the installed version. It is absent from sandbox images and is not the capture authority.
_Avoid_: Daemon, local daemon

**Managed Asset Reconciliation**:
The idempotent, machine-wide maintenance performed by the Member Service on install, start, update, repair, and relevant symbiont changes. It upgrades configuration and schema revisions, launchers/runtime pins, hook and MCP registrations, skill registrations/symlinks, and generated assets for the global installation and every locally registered Project through the canonical writer for each resource. A failure in one Project is reported and retried without hiding it or preventing healthy Projects from converging.
_Avoid_: Treating this as one-time migration work, updating only the current Project, or adding a second writer in update code

**Myco Server**:
The knowledge authority that owns project vaults, user and agent surfaces, and intelligence within a Deployment.
_Avoid_: Daemon, Grove

**Self-hosted Server**:
A Myco Server operated by the user on supported container infrastructure.
_Avoid_: Local server, local Myco

**Cloud-hosted Server**:
A Myco Server operated on Myco's supported managed-cloud infrastructure.
_Avoid_: Cloud Myco

**Deployment**:
One Myco Server authority containing one or more projects. It is the isolation boundary that replaces the Grove boundary in Myco 2.0.
_Avoid_: Grove, instance

**Project**:
A portable body of collective project intelligence whose identity and history survive movement between Deployments. Checkouts of the same Git project contribute member sessions and derived knowledge to the same Project; sharing is inherent in membership of the Deployment, not a separate product operation.
_Avoid_: Treating each checkout, member, or Deployment-local database row as a separate Project

**Project Binding**:
The association from a Git project in a Member Runtime to one Deployment. It determines which server resolves the Project, receives capture, and serves project intelligence. An explicit Project Binding overrides the Default Deployment; it does not create a different kind of Project or sharing relationship.
_Avoid_: Grove binding, Team attachment

**Default Deployment**:
The Deployment selected during setup for safe Git projects that do not yet have an explicit Project Binding.
_Avoid_: Default Grove, inferred server

**Myco Setup**:
The rerunnable post-install workflow invoked with `myco setup`. It creates or connects to Deployments, joins the member, manages saved server connections, selects the Default Deployment, can assign the current Git Project to a different connection, and verifies capture. The public install script has already installed the CLI, resident service, and symbiont integrations.
_Avoid_: Treating package installation alone as server provisioning or multiplying setup behavior across separate project-server commands

**Server Provisioning**:
The independent `myco server ...` operator workflow that creates, updates, inspects, rotates, backs up, adopts, restores, or removes a Deployment. Myco Setup may invoke the same underlying provisioning implementation, but server operation does not depend on running member setup.
_Avoid_: Inventing a separate `myco-server` user-facing CLI or making server lifecycle depend on member setup

**Access Grant**:
A revocable, rotatable authorization issued by a Deployment for a bounded actor and capability scope. The authorization mechanism is a design decision; the domain requires distinct member and external-agent scopes regardless of whether the mechanism uses tokens, identity, approval, or a combination.
_Avoid_: Reusing a full member credential as an external read-only MCP key

**Enrollment Authority**:
A secret or equivalent authority created during Server Provisioning that permits a person to join a Deployment. Joining exchanges that authority for an individually attributable Member Credential; the enrollment authority is not the credential used for ordinary member requests.
_Avoid_: Having every member permanently share the provisioning secret

**Member Credential**:
An individually attributable credential issued when a member joins a Deployment. It grants full Member Access while allowing the server to preserve member identity and revoke or rotate one member's credential independently.
_Avoid_: Using runtime or machine identity as the member's human identity

**Flat Membership (2.0)**:
Every joined member has equal application access across the Deployment: capture, dashboard, project intelligence, normal MCP, generated intelligence, settings, enrollment, and external-agent grant management. A possible step-up admin credential for narrowly sensitive operations does not create user roles.
_Avoid_: Reintroducing owner/member application roles in the initial 2.0 authorization model

**Member Access**:
Full product access granted when a member joins a Deployment. A member may automatically create or resolve Projects from Git checkouts, contribute capture, and use the normal project-intelligence surfaces across the Deployment. Server infrastructure lifecycle remains an operator concern.
_Avoid_: Project-by-project sharing or treating a member's checkout as a private copy

**Member Runtime**:
An environment acting on behalf of a member, whether a persistent Member Installation or an ephemeral sandbox. Runtime location and lifetime are execution metadata, not member identity or authorization scope.
_Avoid_: Treating a sandbox as a separate user or weaker membership class

**Member Registry**:
Machine-local configuration that stores Deployment memberships separately from Project Bindings. A Deployment membership carries the server URL, member identity, and Member Credential; a Project Binding selects one registered Deployment and resolved Project identity.
_Avoid_: Copying a full member credential into every project record

**Project Resolution**:
The automatic process applied after selecting a Deployment: use a portable Project ID when available; otherwise match a normalized Git remote; otherwise create a server-assigned Project identity for the local Git repository. The resolved identity is retained in the member registry, while committed project identity remains the portable path across remotes and machines.
_Avoid_: Using a filesystem path as durable Project identity

**Project Reassignment**:
A server operation for correcting duplicate Project identities. It reassigns authoritative project data from a retired Project ID to the surviving ID, resolves identical key collisions idempotently, removes rebuildable derived intelligence and embeddings affected by the change, deletes the retired Project, and lets normal processing rebuild the combined intelligence.
_Avoid_: Inventing a semantic content-merging workflow, preview system, alias product, or member-side command family for a rare identity correction

**Feature Preservation**:
The governing 2.0 migration rule: replacing local daemon and server infrastructure does not change Myco's major feature set. Every existing capability receives an explicit keep, replace, or intentional-drop decision and an owning surface; infrastructure omission is never a reason to lose functionality.
_Avoid_: Treating a thinner member or a different server target as permission to drop unassigned features

**External Agent Access**:
A project-scoped, read-only Access Grant for an independently hosted cloud agent configured only with Myco MCP access, such as a Copilot review agent. It permits the external read-only MCP surface for its authorized Project and no capture or administrative operations.
_Avoid_: Conflating an MCP-only cloud agent with a member-operated sandbox

**Sandbox Runtime**:
An ephemeral Member Runtime provisioned with the member's normal server access and coding-agent credentials. Its agent acts on behalf of that member, and its sessions are attributed to the member; only the execution environment is temporary.
_Avoid_: Issuing a sandbox-specific reduced access role or recording the sandbox as a separate user

## Migration vocabulary

**Grove (1.4)**:
The legacy physical database boundary that groups projects in Myco 1.4. It names migration source state and is not a Myco 2.0 product concept.
_Avoid_: Using Grove as a synonym for Deployment

**Team / Team Host (1.4)**:
The legacy collaboration and remote-hosting mechanism. It names migration source state and is not a separate Myco 2.0 product concept; collaboration occurs naturally when members of a Deployment contribute work from equivalent Git checkouts to the same Project.
_Avoid_: Carrying Team forward as a second tenancy or binding model

**Archived Project (1.4)**:
Legacy project data explicitly archived before the 2.0 upgrade. Archived Projects are outside the migration set; the 2.0 migration carries active project intelligence only.
_Avoid_: Recreating archived 1.4 projects in 2.0

**Legacy Removal Boundary**:
The 1.4 binary owns removal of the installed 1.4 service and integrations. Its ordinary `myco remove --yes` path preserves the entire Myco home and captured Grove data; `--purge` deletes that data and is forbidden during migration. The 2.0 installer may orchestrate the existing command before replacing the binary but does not reimplement legacy teardown.
_Avoid_: Porting 1.4 uninstall logic into 2.0 or using `--purge` during cutover

## Supported server targets

**Self-hosted Deployment**:
A production Deployment composed of a Bun server container and an intelligence-harness container, with embedded SQLite, local blob and vector storage, and persistent mounted storage under Docker Compose.
_Avoid_: Requiring a separate database service or using a development server as the production runtime

**Cloudflare Deployment**:
A production Deployment using the same server product contract with Cloudflare adapters such as D1, R2, Vectorize, and platform-native scheduling or wake mechanisms.
_Avoid_: Treating the Cloudflare target as a different product

## Configuration and intelligence

**Deployment Settings**:
Server-wide settings for intelligence providers, schedules, retention, server behavior, and protected provider credentials. All members can manage these settings in 2.0, with a possible step-up admin credential for sensitive secret changes.
_Avoid_: Applying Deployment Settings to only the currently selected Project

**Member Settings**:
Machine-local settings for capture, symbionts, spool behavior, local logs, and member preferences.
_Avoid_: Storing machine behavior on the server

**Project Intelligence**:
The project-scoped knowledge produced from every member's contributed work: sessions, Cortex, spores, skills, instructions, Canopy, embeddings, and notifications. Member and runtime identity remain attribution; there is no private per-member intelligence layer.
_Avoid_: Blending unrelated Projects or partitioning collective knowledge by contributor

**Intelligence Provider**:
The provider used by the server-side Myco agent and embedding pipeline. Supported 2.0 credentials include subscription/OAuth flows such as the Claude SDK and API keys for OpenAI-compatible providers. Native Cloudflare harness/provider integration is a follow-up rather than a 2.0 release blocker.
_Avoid_: Making one provider's credential shape part of the Project model
