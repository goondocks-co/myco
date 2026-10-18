.PHONY: build build-all build-fast build-only build-rebuild rebuild check check-fast check-all test test-fast test-integration test-all lint clean watch install prepare-build source-build source-install worktree-sweep source-build-windows

.DEFAULT_GOAL := build

HOST_TARGET = $(shell node -e "process.stdout.write(process.platform + '-' + (process.arch === 'arm64' ? 'arm64' : 'x64'))")
NODE_ENGINE = $(shell sed -n 's/.*"node":[[:space:]]*"\([^"]*\)".*/\1/p' packages/myco/package.json)
BUN_NOTICE_SHOWN_ON_ENTRY := $(MYCO_BUN_NOTICE_SHOWN)
export MYCO_BUN_NOTICE_SHOWN := 1

.PHONY: deps
deps:
	@command -v node >/dev/null 2>&1 || { echo 'Myco: Node.js $(NODE_ENGINE) with npm is required. Install from https://nodejs.org/.' >&2; exit 1; }
	@MYCO_BUN_NOTICE_SHOWN="$(BUN_NOTICE_SHOWN_ON_ENTRY)" node scripts/ensure-deps.mjs $(if $(filter source-build-windows,$(MAKECMDGOALS)),--windows)

build: check-fast
	$(MAKE) build-only
build-all: check-all
	$(MAKE) build-only
build-fast: build
build-only: deps
	npm run build
build-rebuild: rebuild build
rebuild: deps
	npm rebuild
check-fast: lint test-fast
check-all: lint test-all
check: check-all
lint: deps
	npm run lint
test: test-fast
test-fast: deps
	npm run test:fast
test-all: deps
	npm test
test-integration: deps
	npm run test:integration
watch: deps
	npm run build:watch
clean:
	rm -rf packages/myco/dist packages/myco-shared/dist
install: deps

# Native assets and generated carriers required by the compiled product.
prepare-build: deps
	bash packages/myco/scripts/build-libsqlite3-target.sh $(HOST_TARGET)
	npm run build:ui -w @goondocks/myco
	cd packages/myco && npm run codegen

source-build: prepare-build
	cd packages/myco && TARGET=$(HOST_TARGET) node scripts/build-single-target.mjs
	cd packages/myco && node scripts/verify-build.mjs

source-install: deps
	node --import tsx scripts/source-install.ts

worktree-sweep: deps
	@node scripts/worktree-sweep.mjs $(ARGS)


# Cross-compile the same member/server product for a Windows development machine.
source-build-windows: deps
	npm run build:ui -w @goondocks/myco
	cd packages/myco && npm run codegen
	npm i --no-save --force sqlite-vec-windows-x64 @vscode/ripgrep-win32-x64
	bash packages/myco/scripts/build-libsqlite3-target.sh windows-x64
	cd packages/myco && BASELINE=1 TARGET=windows-x64 node scripts/build-single-target.mjs
