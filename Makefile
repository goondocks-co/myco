.PHONY: build build-all build-fast build-only build-rebuild rebuild check check-fast check-all test test-fast test-integration test-all lint clean watch install dev-build dev-link dev-link-worktree dev-unlink dev-unlink-worktree ui-dev collective-ui-dev daemon-dev dev ui ui-myco ui-collective

# `make build` runs the fast unit-test profile + build. Integration / smoke
# tests are deliberately excluded from the inner dev loop — they pair real
# subprocesses, lsof scans, port binding, and disk I/O, which costs ~100s
# per run AND flakes under parallel load. The full sweep still runs in CI
# on every PR; locally, use `make build-all` only when you specifically
# need pre-release confidence.
build:
	$(MAKE) check-fast
	npm run build

# Legacy / explicit full sweep: lint + every test bucket including
# integration + smoke. Use before tagging a release; CI always runs this.
build-all:
	$(MAKE) check-all
	npm run build

build-packages:
	$(MAKE) check-fast
	npm run build:packages

# Alias retained for backward compatibility with existing automation.
build-fast: build

build-only:
	npm run build

# Force-rebuild native modules (better-sqlite3, esbuild, etc.) before running
# the full quality gate. Use this after switching branches when `make build`
# segfaults — the compiled `.node` binaries in `node_modules` go stale across
# branches with different Node versions or native-dep versions, and the
# concurrent `-j2 check` step races them into a crash.
build-rebuild: rebuild build

rebuild:
	npm rebuild

check-fast: lint test-fast

# Full quality gate — every test bucket. Slow; intended for CI / pre-release.
check-all: lint test-all

# Backward-compatible alias — `check` historically meant the full sweep.
check: check-all

lint:
	npm run lint

# `test` is now the fast unit profile to match the renamed `build` semantics.
test:
	npm run test:fast

test-fast:
	npm run test:fast

test-all:
	npm test

test-integration:
	npm run test:integration

watch:
	npm run build:watch

clean:
	rm -rf packages/myco/dist packages/myco-team/dist packages/myco-collective/dist packages/myco-shared/dist

# Build every UI bundle (myco daemon UI + collective UI) without running the
# rest of the quality gate or the host-target compile. Useful when iterating
# on frontend changes that ship inside the daemon binary — re-run after
# editing UI source so `bun packages/myco/src/entries/cli.ts daemon` picks up
# the freshly built `dist/`.
ui: ui-myco ui-collective

ui-myco:
	cd packages/myco/ui && npx vite build

ui-collective:
	cd packages/myco-collective/ui && npx vite build

install:
	npm install

ui-dev:
	@port=$${MYCO_DAEMON_PORT:-$$(node -e ' \
		var fs=require("fs"),p=require("path"),v=p.join(require("os").homedir(),".myco/vaults/myco"); \
		try{console.log(JSON.parse(fs.readFileSync(p.join(v,"daemon.json"),"utf-8")).port);process.exit(0)}catch{} \
		try{var y=fs.readFileSync(p.join(v,"myco.yaml"),"utf-8"),m=y.match(/^\\s*port:\\s*(\\d+)/m);if(m){console.log(m[1]);process.exit(0)}}catch{} \
		console.log(19200)')}; \
	echo "Proxying API to daemon on port $$port (override with MYCO_DAEMON_PORT=<port> make ui-dev)"; \
	cd packages/myco/ui && MYCO_DAEMON_PORT=$$port npx vite dev

collective-ui-dev:
	@collective_name=$${COLLECTIVE_NAME:-oss}; \
	target=$${COLLECTIVE_UI_PROXY_TARGET:-$$(COLLECTIVE_NAME=$$collective_name node -e ' \
		var fs=require("fs"),p=require("path"),os=require("os"); \
		var name=process.env.COLLECTIVE_NAME||"oss"; \
		var file=p.join(os.homedir(),".myco-collective",name,"config.json"); \
		if(!fs.existsSync(file)){process.stderr.write("Missing Collective config at "+file+"\\n");process.exit(1)} \
		var config=JSON.parse(fs.readFileSync(file,"utf-8")); \
		if(!config.worker_url){process.stderr.write("Collective config at "+file+" is missing worker_url\\n");process.exit(1)} \
		process.stdout.write(config.worker_url)')}; \
	echo "Proxying Collective UI to $$target (override with COLLECTIVE_UI_PROXY_TARGET=<url> or COLLECTIVE_NAME=<name> make collective-ui-dev)"; \
	cd packages/myco-collective/ui && COLLECTIVE_UI_PROXY_TARGET="$$target" npx vite dev

daemon-dev:
	@proxy=$${MYCO_UI_DEV_PROXY_TARGET:-http://127.0.0.1:5173}; \
	echo "Starting watched daemon with UI dev proxy $$proxy (MYCO_HOME=$(HOME)/.myco-dev)"; \
	MYCO_HOME=$(HOME)/.myco-dev MYCO_CLAIMS_HOME=$(HOME)/.myco MYCO_UI_DEV_PROXY_TARGET="$$proxy" bun --watch packages/myco/src/entries/cli.ts daemon

dev:
	@ui_port=$${MYCO_UI_DEV_PORT:-5173}; \
	daemon_port=$${MYCO_DAEMON_PORT:-$$(node -e ' \
		var fs=require("fs"),p=require("path"); \
		var root=process.cwd(); \
		var daemonJson=p.join(root,".myco","daemon.json"); \
		var configPath=p.join(root,".myco","myco.yaml"); \
		try{console.log(JSON.parse(fs.readFileSync(daemonJson,"utf-8")).port);process.exit(0)}catch{} \
		try{var y=fs.readFileSync(configPath,"utf-8"),m=y.match(/^\s*port:\s*(\d+)/m);if(m){console.log(m[1]);process.exit(0)}}catch{} \
		console.log(19200)')}; \
	proxy=$${MYCO_UI_DEV_PROXY_TARGET:-http://127.0.0.1:$$ui_port}; \
	echo "Starting watched daemon (expected port $$daemon_port) with UI proxy $$proxy"; \
	echo "Open http://127.0.0.1:$$daemon_port/ for integrated dev or http://127.0.0.1:$$ui_port/ for raw Vite"; \
	trap 'kill $$vite_pid 2>/dev/null || true' EXIT INT TERM; \
	(cd packages/myco/ui && MYCO_DAEMON_PORT=$$daemon_port npx vite dev --host 127.0.0.1 --port $$ui_port) & vite_pid=$$!; \
	MYCO_UI_DEV_PROXY_TARGET="$$proxy" npx tsx watch \
		--exclude ".myco/**" \
		--exclude ".playwright-cli/**" \
		--exclude "packages/myco/ui/**" \
		--exclude "packages/myco/dist/**" \
		packages/myco/src/entries/cli.ts daemon

HOST_TARGET := $(shell node -e "\
process.stdout.write(process.platform === 'darwin' ? 'darwin-' + (process.arch === 'arm64' ? 'arm64' : 'x64') : \
process.platform === 'linux' ? 'linux-' + (process.arch === 'arm64' ? 'arm64' : 'x64') : \
'windows-x64')")

dev-build:
	@# myco-team and myco-collective build via bun build (Node ESM, not standalone binaries).
	npm run build -w @goondocks/myco-team
	npm run build -w @goondocks/myco-collective
	@# myco is now a Bun-compiled binary. Steps in order:
	@#   1. build libsqlite3 for the host target (cached after first run)
	@#   2. build UI bundle (Vite) — must precede codegen so it can be embedded
	@#   3. codegen (hook-config + agent defs + static + UI assets, templates)
	@#   4. bun build --compile the host-target entry (embeds the codegen output)
	bash packages/myco/scripts/build-libsqlite3-target.sh $(HOST_TARGET)
	cd packages/myco && { test -d ui/node_modules || (cd ui && npm ci); } && cd ui && npx vite build
	cd packages/myco && npm run codegen
	cd packages/myco && TARGET=$(HOST_TARGET) node scripts/build-single-target.mjs
	@# After the binary lands in packages/myco-$(HOST_TARGET)/bin/, re-run
	@# select-binary.mjs so vendor/resolved.json is populated for callers
	@# that go through bin/myco.cjs directly (postinstall already ran during
	@# `npm ci` but found no binary then; the source-checkout escape exited
	@# 0 without writing the resolution).
	cd packages/myco && node scripts/select-binary.mjs

dev-link: dev-build
	@mkdir -p $(HOME)/.local/bin
	@mkdir -p $(HOME)/.myco
	@# Install myco-dev as a thin wrapper (not a bare symlink) that pins the dev
	@# home + shared claims, so `myco-dev <cmd>` targets ~/.myco-dev AND any
	@# hook/launcher that re-execs the runtime.command pin inherits the same env
	@# — the dev daemon then defers symbiont-config to prod's ~/.myco claim
	@# instead of reading its own empty claims. The binary bundles Bun, so the
	@# caller's Node version is irrelevant.
	@# rm -f FIRST: a prior dev-link left myco-dev as a SYMLINK to the binary, and
	@# `printf > symlink` follows it, overwriting the real binary with this wrapper
	@# — which then execs itself (infinite re-exec). Always write a fresh file.
	@rm -f $(HOME)/.local/bin/myco-dev
	@printf '#!/bin/sh\nexport MYCO_HOME="$$HOME/.myco-dev"\nexport MYCO_CLAIMS_HOME="$$HOME/.myco"\nexec "%s/packages/myco-%s/bin/myco" "$$@"\n' "$(PWD)" "$(HOST_TARGET)" > $(HOME)/.local/bin/myco-dev
	@chmod +x $(HOME)/.local/bin/myco-dev
	@ln -sf $(PWD)/packages/myco-team/dist/main.js $(HOME)/.local/bin/myco-team-dev
	@chmod +x $(HOME)/.local/bin/myco-team-dev
	@ln -sf $(PWD)/packages/myco-collective/dist/main.js $(HOME)/.local/bin/myco-collective-dev
	@chmod +x $(HOME)/.local/bin/myco-collective-dev
	@ln -sf $(PWD)/packages/myco/bin/myco-run $(HOME)/.local/bin/myco-run
	@chmod +x $(HOME)/.local/bin/myco-run
	@# Write the absolute path of the dev binary to the project-scope
	@# runtime.command so every launcher (hook guard, MCP, CLI shim,
	@# daemon respawn) inside this repo dispatches to the same dev binary.
	@# GUI-launched agents run under launchd's minimal PATH which excludes
	@# ~/.local/bin; baking the absolute path at link time makes hook
	@# capture robust under both GUI and shell launches.
	@#
	@# Project-scope (not machine-scope) so dev mode applies only when the
	@# user is working inside this repo. Outside it, `myco` resolves to the
	@# globally-installed binary as users expect.
	@mkdir -p $(PWD)/.myco
	@printf '%s/.local/bin/myco-dev\n' "$(HOME)" > $(PWD)/.myco/runtime.command
	@# Set up the dev home directory and pin runtime.home so the daemon reads
	@# from ~/.myco-dev instead of ~/.myco, keeping dev state isolated.
	@mkdir -p $(HOME)/.myco-dev
	@# Create the dev config only if absent so a re-link never clobbers a
	@# contributor's edits (e.g. a pinned `daemon.port`).
	@test -f $(HOME)/.myco-dev/config.yaml || printf 'daemon:\n  update_channel: manual\n' > $(HOME)/.myco-dev/config.yaml
	@printf '%s/.myco-dev\n' "$(HOME)" > $(PWD)/.myco/runtime.home
	@chmod 0644 $(PWD)/.myco/runtime.home
	@echo "✓ $(HOME)/.myco-dev/config.yaml written (update_channel: manual)"
	@echo "✓ $(PWD)/.myco/runtime.home set to $(HOME)/.myco-dev"
	@# Sweep any pre-0.25.2 machine-scope pin written by older `make dev-link`
	@# runs — it would shadow the new project pin from outside the repo.
	@if [ -f $(HOME)/.myco/runtime.command ]; then \
		rm -f $(HOME)/.myco/runtime.command; \
		echo "✓ removed legacy machine-scope ~/.myco/runtime.command (migrated to project pin)"; \
	fi
	@echo "✓ myco-dev symlinked to $(PWD)/packages/myco-$(HOST_TARGET)/bin/myco"
	@echo "✓ myco-team-dev symlinked to $(PWD)/packages/myco-team/dist/main.js"
	@echo "✓ myco-collective-dev symlinked to $(PWD)/packages/myco-collective/dist/main.js"
	@echo "✓ myco-run symlinked to $(PWD)/packages/myco/bin/myco-run"
	@echo "✓ $(PWD)/.myco/runtime.command set to $(HOME)/.local/bin/myco-dev"
	@# Regenerate symbiont configs across every registered project so any
	@# that opt into `substituteRuntimeCommand` (opencode today) get the
	@# runtime.command alias baked into their MCP command. Symbionts that
	@# rely on `bin/myco-run` to read runtime.command at spawn time are
	@# unaffected — `myco update` is a no-op for them.
	@if command -v myco-dev >/dev/null 2>&1; then \
		myco-dev update --all-projects || echo "⚠ 'myco-dev update --all-projects' failed — symbiont configs may not reflect runtime.command=myco-dev"; \
	else \
		echo "⚠ myco-dev not on PATH — skipping symbiont config refresh"; \
	fi

# Windows dogfood — the same shape as `dev-build` / `dev-link`, for a remote
# Windows host (set WIN_HOST). The binary is cross-built here (the Windows box
# only runs it). Wiring is NOT Windows-bespoke: pin `~/.myco/runtime.command`
# to the binary (the launcher-resolution abstraction macOS dev-link also uses)
# and let the daemon's first-start `runGlobalBootstrap` install launchers +
# wire symbionts — identical on every platform. BASELINE=1 builds Bun's
# no-AVX2 variant so it runs under Windows-on-ARM x64 emulation / older CPUs.
WIN_HOST ?= chris@10.211.55.3
WIN_SSH := -o ControlMaster=auto -o ControlPath=/tmp/myco-win-ssh -o ControlPersist=3m -o StrictHostKeyChecking=accept-new

dev-build-windows:
	@# UI bundle first (served by the daemon, embedded into the binary) — must
	@# precede codegen so gen-ui-assets can bundle it. Parity with `dev-build`.
	cd packages/myco/ui && { test -d node_modules || npm ci; } && npx vite build
	cd packages/myco && npm run codegen
	@# npm skips foreign-platform optionalDeps; pull the windows-x64 native deps explicitly.
	npm i --no-save --force sqlite-vec-windows-x64 @vscode/ripgrep-win32-x64
	bash packages/myco/scripts/build-libsqlite3-target.sh windows-x64
	cd packages/myco && BASELINE=1 TARGET=windows-x64 node scripts/build-single-target.mjs

dev-link-windows: dev-build-windows
	tar -czf /tmp/myco-win-ui.tgz -C packages/myco/dist ui
	scp $(WIN_SSH) packages/myco-windows-x64/bin/myco.exe $(WIN_HOST):myco.exe
	scp $(WIN_SSH) /tmp/myco-win-ui.tgz $(WIN_HOST):ui.tgz
	scp $(WIN_SSH) scripts/win-dev-link.ps1 $(WIN_HOST):win-dev-link.ps1
	ssh $(WIN_SSH) $(WIN_HOST) 'powershell -NoProfile -ExecutionPolicy Bypass -File win-dev-link.ps1'
	@echo "✓ wired on $(WIN_HOST) — daemon running + UI staged (see the printed port)."

dev-unlink:
	@rm -f $(HOME)/.local/bin/myco-dev
	@rm -f $(HOME)/.local/bin/myco-team-dev
	@rm -f $(HOME)/.local/bin/myco-collective-dev
	@rm -f $(HOME)/.local/bin/myco-run
	@rm -f $(PWD)/.myco/runtime.command
	@rm -f $(PWD)/.myco/runtime.home
	@# Also sweep the legacy machine-scope pin in case the user ran the
	@# pre-0.25.2 `make dev-link` and never re-linked.
	@rm -f $(HOME)/.myco/runtime.command
	@echo "✓ myco-dev symlink removed"
	@echo "✓ myco-team-dev symlink removed"
	@echo "✓ myco-collective-dev symlink removed"
	@echo "✓ myco-run symlink removed"
	@echo "✓ $(PWD)/.myco/runtime.command removed — launchers fall back to default 'myco'"
	@echo "✓ $(PWD)/.myco/runtime.home removed"

dev-link-worktree: dev-build
	@mkdir -p $(PWD)/.myco
	@# Pin THIS worktree to its own freshly-built binary. Do NOT touch the
	@# shared ~/.local/bin/myco-dev symlink — the main checkout and other
	@# agents rely on it. `.myco/runtime.command` is gitignored, so
	@# `git worktree add` never carries the main checkout's pin; without this
	@# the worktree falls back to prod `myco`. The global launcher + bin/myco-run
	@# resolve the binary by walking up from cwd, so hooks, MCP, and CLI in this
	@# worktree all dispatch to the worktree build. Routing detail + the
	@# shared-vault schema caveat: see the `dogfood-worktree` skill.
	@printf '%s/packages/myco-%s/bin/myco\n' "$(PWD)" "$(HOST_TARGET)" > $(PWD)/.myco/runtime.command
	@echo "✓ $(PWD)/.myco/runtime.command pinned to packages/myco-$(HOST_TARGET)/bin/myco"
	@echo "  (worktree-local pin; shared ~/.local/bin/myco-dev symlink unchanged)"

dev-unlink-worktree:
	@rm -f $(PWD)/.myco/runtime.command
	@echo "✓ $(PWD)/.myco/runtime.command removed — worktree falls back to the resolution chain"
