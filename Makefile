.PHONY: build build-fast build-only check check-fast test test-fast test-integration lint clean watch install dev-link dev-unlink ui-dev collective-ui-dev

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
	rm -rf packages/myco/dist packages/myco-team/dist packages/myco-collective/dist

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

dev-link:
	npm run build
	@mkdir -p $(HOME)/.local/bin
	@ln -sf $(PWD)/packages/myco/dist/src/cli.js $(HOME)/.local/bin/myco-dev
	@chmod +x $(HOME)/.local/bin/myco-dev
	@ln -sf $(PWD)/packages/myco-team/dist/main.js $(HOME)/.local/bin/myco-team-dev
	@chmod +x $(HOME)/.local/bin/myco-team-dev
	@ln -sf $(PWD)/packages/myco-collective/dist/main.js $(HOME)/.local/bin/myco-collective-dev
	@chmod +x $(HOME)/.local/bin/myco-collective-dev
	@ln -sf $(PWD)/packages/myco/bin/myco-run $(HOME)/.local/bin/myco-run
	@chmod +x $(HOME)/.local/bin/myco-run
	@mkdir -p .myco
	@printf 'myco-dev\n' > .myco/runtime.command
	@echo "✓ myco-dev symlinked to $(PWD)/packages/myco/dist/src/cli.js"
	@echo "✓ myco-team-dev symlinked to $(PWD)/packages/myco-team/dist/main.js"
	@echo "✓ myco-collective-dev symlinked to $(PWD)/packages/myco-collective/dist/main.js"
	@echo "✓ myco-run symlinked to $(PWD)/packages/myco/bin/myco-run"
	@echo "✓ .myco/runtime.command set to myco-dev"
	@echo "  (the hook guard at .agents/myco-run.cjs reads this file)"

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
