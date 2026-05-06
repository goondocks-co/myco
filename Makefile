.PHONY: build build-fast build-only build-rebuild rebuild check check-fast test test-fast test-integration lint clean watch install dev-build dev-link dev-link-worktree dev-unlink dev-unlink-worktree ui-dev collective-ui-dev daemon-dev dev ui ui-myco ui-collective

build:
	$(MAKE) check
	npm run build

build-fast:
	$(MAKE) check-fast
	npm run build

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

check: lint test

check-fast: lint test-fast

lint:
	npm run lint

test:
	npm test

test-fast:
	npm run test:fast

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
	echo "Starting watched daemon with UI dev proxy $$proxy"; \
	MYCO_UI_DEV_PROXY_TARGET="$$proxy" bun --watch packages/myco/src/entries/cli.ts daemon

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
	@# myco-team and myco-collective stay on tsup/Node.
	npm run build -w @goondocks/myco-team
	npm run build -w @goondocks/myco-collective
	@# myco is now a Bun-compiled binary. Steps in order:
	@#   1. codegen (hook-config.generated.ts from manifests)
	@#   2. build libsqlite3 for the host target (cached after first run)
	@#   3. build UI bundle (Vite)
	@#   4. bun build --compile the host-target entry
	cd packages/myco && npx tsx scripts/gen-hook-config.ts
	bash packages/myco/scripts/build-libsqlite3-target.sh $(HOST_TARGET)
	cd packages/myco && { test -d ui/node_modules || (cd ui && npm ci); } && cd ui && npx vite build
	cd packages/myco && TARGET=$(HOST_TARGET) node scripts/build-single-target.mjs

dev-link: dev-build
	@mkdir -p $(HOME)/.local/bin
	@# Symlink the host-target Bun binary as myco-dev. The binary bundles
	@# the Bun runtime, so the caller's Node version is irrelevant.
	@ln -sf $(PWD)/packages/myco/vendor/$(HOST_TARGET)/myco $(HOME)/.local/bin/myco-dev
	@chmod +x $(HOME)/.local/bin/myco-dev
	@ln -sf $(PWD)/packages/myco-team/dist/main.js $(HOME)/.local/bin/myco-team-dev
	@chmod +x $(HOME)/.local/bin/myco-team-dev
	@ln -sf $(PWD)/packages/myco-collective/dist/main.js $(HOME)/.local/bin/myco-collective-dev
	@chmod +x $(HOME)/.local/bin/myco-collective-dev
	@ln -sf $(PWD)/packages/myco/bin/myco-run $(HOME)/.local/bin/myco-run
	@chmod +x $(HOME)/.local/bin/myco-run
	@mkdir -p .myco
	@# Write the absolute path of the dev binary so the hook guard can
	@# exec it directly without a PATH lookup. GUI-launched agents run
	@# under launchd's minimal PATH which excludes ~/.local/bin; baking
	@# the absolute path at link time makes hook capture robust under
	@# both GUI and shell launches.
	@printf '%s/.local/bin/myco-dev\n' "$(HOME)" > .myco/runtime.command
	@echo "✓ myco-dev symlinked to $(PWD)/packages/myco/vendor/$(HOST_TARGET)/myco"
	@echo "✓ myco-team-dev symlinked to $(PWD)/packages/myco-team/dist/main.js"
	@echo "✓ myco-collective-dev symlinked to $(PWD)/packages/myco-collective/dist/main.js"
	@echo "✓ myco-run symlinked to $(PWD)/packages/myco/bin/myco-run"
	@echo "✓ .myco/runtime.command set to $(HOME)/.local/bin/myco-dev"
	@echo "  (the hook guard at .agents/myco-run.cjs reads this file)"
	@# Regenerate symbiont configs so any that opt into
	@# `substituteRuntimeCommand` (opencode today) get the runtime.command
	@# alias baked into their MCP command. Symbionts that rely on
	@# `bin/myco-run` to read runtime.command at spawn time are unaffected
	@# — `myco update` is a no-op for them.
	@if command -v myco-dev >/dev/null 2>&1; then \
		myco-dev update --project "$(PWD)" || echo "⚠ 'myco-dev update --project $(PWD)' failed — symbiont configs may not reflect runtime.command=myco-dev"; \
	else \
		echo "⚠ myco-dev not on PATH — skipping symbiont config refresh"; \
	fi

dev-link-worktree: dev-build
	@mkdir -p .myco
	@# Worktrees must not rewrite the shared ~/.local/bin/myco-dev symlink:
	@# other agents may already be using it from the main checkout. Pin this
	@# worktree directly to its compiled binary instead.
	@printf '%s/packages/myco/vendor/%s/myco\n' "$(PWD)" "$(HOST_TARGET)" > .myco/runtime.command
	@echo "✓ .myco/runtime.command set to $(PWD)/packages/myco/vendor/$(HOST_TARGET)/myco"
	@echo "  (worktree-local pin; global myco-dev symlink unchanged)"
	@./packages/myco/vendor/$(HOST_TARGET)/myco update --project "$(PWD)" || echo "⚠ worktree update failed — symbiont configs may not reflect the worktree runtime.command"

dev-unlink:
	@rm -f $(HOME)/.local/bin/myco-dev
	@rm -f $(HOME)/.local/bin/myco-team-dev
	@rm -f $(HOME)/.local/bin/myco-collective-dev
	@rm -f $(HOME)/.local/bin/myco-run
	@rm -f .myco/runtime.command
	@echo "✓ myco-dev symlink removed"
	@echo "✓ myco-team-dev symlink removed"
	@echo "✓ myco-collective-dev symlink removed"
	@echo "✓ myco-run symlink removed"
	@echo "✓ .myco/runtime.command removed — hook guard falls back to default 'myco'"

dev-unlink-worktree:
	@rm -f .myco/runtime.command
	@echo "✓ .myco/runtime.command removed — worktree falls back to inherited/default runtime"
	@if [ -x ./packages/myco/vendor/$(HOST_TARGET)/myco ]; then \
		./packages/myco/vendor/$(HOST_TARGET)/myco update --project "$(PWD)" || echo "⚠ worktree update failed after removing runtime.command"; \
	else \
		echo "⚠ local binary missing — run make dev-link-worktree before refreshing symbiont configs"; \
	fi
	@# Regenerate symbiont configs using prod myco so any
	@# `substituteRuntimeCommand` opt-ins revert their MCP command from
	@# the dev alias back to `myco-run`. Soft-fail when prod myco isn't
	@# installed — the user can run `myco update` manually later.
	@if command -v myco >/dev/null 2>&1; then \
		myco update || echo "⚠ 'myco update' failed — run it manually to restore symbiont configs"; \
	else \
		echo "⚠ myco not on PATH — run 'myco update' manually after installing prod myco"; \
	fi
