.PHONY: build build-only check test lint clean watch install dev-link dev-unlink ui-dev

build: check
	npm run build

build-only:
	npm run build

check: lint test

lint:
	npx tsc --noEmit

test:
	npx vitest run

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
	@node -e '\
		const fs = require("fs"); \
		const p = ".claude/settings.json"; \
		let s = {}; \
		try { s = JSON.parse(fs.readFileSync(p, "utf-8")); } catch {} \
		s.env = s.env || {}; \
		s.env.MYCO_CMD = "myco-dev"; \
		fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");'
	@echo "✓ myco-dev linked to local build"
	@echo "✓ MYCO_CMD=myco-dev set in .claude/settings.json"

dev-unlink:
	@rm -f $(HOME)/.local/bin/myco-dev
	@node -e '\
		const fs = require("fs"); \
		const p = ".claude/settings.json"; \
		try { \
			const s = JSON.parse(fs.readFileSync(p, "utf-8")); \
			if (s.env) { delete s.env.MYCO_CMD; } \
			fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n"); \
		} catch {}'
	@echo "✓ myco-dev unlinked"
	@echo "✓ MYCO_CMD removed from .claude/settings.json"
