.PHONY: build build-fast build-only check check-fast test test-fast test-integration lint clean watch install dev-link dev-unlink ui-dev

build:
	$(MAKE) -j2 check
	npm run build

build-fast:
	$(MAKE) -j2 check-fast
	npm run build

build-only:
	npm run build

check: lint test

check-fast: lint test-fast

lint:
	npx tsc --noEmit

test:
	npx vitest run

test-fast:
	npm run test:fast

test-integration:
	npm run test:integration

watch:
	npm run build:watch

clean:
	rm -rf dist

install:
	npm install

ui-dev:
	@port=$${MYCO_DAEMON_PORT:-$$(node -e ' \
		var fs=require("fs"),p=require("path"),v=p.join(require("os").homedir(),".myco/vaults/myco"); \
		try{console.log(JSON.parse(fs.readFileSync(p.join(v,"daemon.json"),"utf-8")).port);process.exit(0)}catch{} \
		try{var y=fs.readFileSync(p.join(v,"myco.yaml"),"utf-8"),m=y.match(/^\\s*port:\\s*(\\d+)/m);if(m){console.log(m[1]);process.exit(0)}}catch{} \
		console.log(19200)')}; \
	echo "Proxying API to daemon on port $$port (override with MYCO_DAEMON_PORT=<port> make ui-dev)"; \
	cd ui && MYCO_DAEMON_PORT=$$port npx vite dev

dev-link:
	npm run build
	@mkdir -p $(HOME)/.local/bin
	@ln -sf $(PWD)/dist/src/cli.js $(HOME)/.local/bin/myco-dev
	@chmod +x $(HOME)/.local/bin/myco-dev
	@mkdir -p .myco
	@printf 'myco-dev\n' > .myco/runtime.command
	@echo "✓ myco-dev symlinked to $(PWD)/dist/src/cli.js"
	@echo "✓ .myco/runtime.command set to myco-dev"
	@echo "  (the hook guard at .agents/myco-run.cjs reads this file)"

dev-unlink:
	@rm -f $(HOME)/.local/bin/myco-dev
	@rm -f $(HOME)/.local/bin/myco-run
	@rm -f .myco/runtime.command
	@echo "✓ myco-dev symlink removed"
	@echo "✓ legacy myco-run symlink removed (if present)"
	@echo "✓ .myco/runtime.command removed — hook guard falls back to default 'myco'"
