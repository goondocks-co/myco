# Plugin release versions and Git updates

Research checked against current primary documentation on 2026-10-08 for [issue #1709](https://github.com/goondocks-co/myco/issues/1709).

## Compatibility

Removing `version` from every emitted manifest is not a documented compatibility contract for the current bundle.

| Format | May omit `version`? | Primary evidence |
| --- | --- | --- |
| Claude Code `.claude-plugin/plugin.json` | Yes; validation warns. | Only `name` is required. An explicit version pins updates until the string changes. [Manifest reference](https://code.claude.com/docs/en/plugins-reference#version) |
| Cursor `.cursor-plugin/plugin.json` | Yes. | `version` appears under optional fields; `name` is the required field. [Plugins reference](https://cursor.com/docs/reference/plugins#optional-fields) |
| Agent Plugins 1.0 root `plugin.json` | Yes. | The normative required fields and JSON Schema require only `$schema` and `name`. Version is metadata; clients may use it for updates and freshness. [Specification](https://agent-plugins.org/specification), [schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json) |
| Codex standalone `.codex-plugin/plugin.json` | Keep it. | OpenAI explicitly marks `version` required in the Codex package format, optional in the portable schema. This documents the package/submission contract; it does not prove every local loader rejects an omitted version. [Package identity table](https://developers.openai.com/plugins/deploy/submission#package-identity-and-components) |

OpenAI also supports a portable root manifest with Codex compatibility metadata. The portable root remains canonical for identity. Omitting versions through that route would need separate validation of the actual bundle and supported clients; native-format omission must not be inferred from portable-schema optionality. [OpenAI package guide](https://developers.openai.com/plugins/build/plugins#plugin-structure)

## Git updates

Claude computes the installed version from the plugin manifest first, the marketplace entry second, and source identity only when neither declares a version. Git sources then use a shortened source commit SHA; a relative plugin path inside a Git-hosted marketplace uses the installed directory's commit SHA. Equal computed versions suppress cached-file replacement even on an explicit update. Therefore a permanent `0.0.0-dev` pins the Git-distributed plugin. Removing only the marketplace version cannot fix it. Claude supports commit tracking when both versions are absent. [Loading reference](https://code.claude.com/docs/en/plugins/loading#how-claude-code-computes-the-version)

Git selection and plugin version are separate controls. Claude source `ref` selects a branch or tag, while `sha` selects a commit and takes precedence when both are present. Updating a manifest cannot make an immutable selector advance. [Marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference#plugin-sources)

Codex documents Git marketplace refs, `ref`/`sha` plugin selectors, and `codex plugin marketplace upgrade` for refresh. The cited guide does not establish a universal SHA fallback or a guarantee that unchanged manifest versions refresh every Git installation. [OpenAI package guide](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli)

Cursor's team-marketplace GitHub refresh follows the tracked branch, automatically or manually; automatic indexing batches pushes at most once per ten minutes. Public marketplace updates require review. These are distinct distribution paths; neither documents an assurance that every direct Git installation advances on a version bump. [Team marketplace refresh](https://cursor.com/docs/plugins#keep-plugins-up-to-date), [marketplace security](https://cursor.com/help/security-and-privacy/marketplace-security)

## Recommendation for #1709

Use one tracked plugin release version, independent of development npm metadata, and retain an explicit semantic version in all four manifests and the marketplace entry. The proposed `plugin-version.json` source and preparation command fit the existing single-bundle architecture. [Architecture §3.4](../architecture/myco-2.0.md#34-member-installation-plugins-and-tenancy), [generator](../../packages/myco/scripts/gen-plugin-bundle.ts)

The release preparation command should validate the supplied version, write the tracked source, and regenerate the bundle. Commit those outputs in the release preparation PR **before** creating the tag. For the intended prerelease, that committed source would be `2.0.0-alpha.1`; npm package manifests can retain their development value until build-time stamping.

A real `myco/v<version>` publication should refuse when the committed plugin version differs from the tag. The exact tagged commit must also pass the existing byte-comparison codegen gate, proving every emitted manifest and skill matches its source. Dry-run binary builds can use hypothetical binary versions without claiming a plugin release. CI must not repair the tagged Git tree or push a generated commit to main.

This fixes Claude's update identity while retaining versions for native Codex distribution and portable clients. It makes Git-visible metadata durable; a GitHub release ZIP alone would not change the repository bytes consumed by the current relative marketplace source. An actual plugin archive/listing publication would be an additional distribution step, with its own source URL or marketplace submission, rather than evidence that the Git plugin updated.

## Checked locally

At inspection, `git show HEAD:<path>` confirmed `0.0.0-dev` in the four plugin manifests and marketplace entry. The generator reads the npm package version, and the publish workflow regenerates the bundle in its working checkout after package stamping. [Generator](../../packages/myco/scripts/gen-plugin-bundle.ts), [workflow](../../.github/workflows/publish.yml)

Two disposable manifests were checked with the installed `claude plugin validate` under the isolated lane configuration. Omitting version exited 0 with a missing-version warning; `2.0.0-alpha.1` exited 0 without warnings. No plugin was installed or updated, and no Myco command or model request was run. Cursor and Codex install/update behavior was researched from official docs, not exercised locally.
