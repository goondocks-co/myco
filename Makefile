.PHONY: build check test lint clean watch install dev-link dev-unlink

build: check
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
