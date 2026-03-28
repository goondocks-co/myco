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
	@ln -sf $(PWD)/bin/myco-run $(HOME)/.local/bin/myco-run
	@chmod +x $(HOME)/.local/bin/myco-run
	@node -e '\
		const fs = require("fs"), path = require("path"); \
		function setEnvJson(p, key, val) { \
			let s = {}; \
			try { s = JSON.parse(fs.readFileSync(p, "utf-8")); } catch {} \
			s.env = s.env || {}; s.env[key] = val; \
			fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n"); \
		} \
		function setEnvToml(p, key, val) { \
			let raw = ""; \
			try { raw = fs.readFileSync(p, "utf-8"); } catch { return; } \
			const section = "[mcp_servers.myco.env]"; \
			const entry = key + " = \"" + val + "\""; \
			if (raw.includes(section)) { \
				const lines = raw.split("\n"); \
				const idx = lines.findIndex(l => l.trim() === section); \
				const existing = lines.findIndex((l, i) => i > idx && l.startsWith(key + " =")); \
				if (existing > -1) { lines[existing] = entry; } \
				else { lines.splice(idx + 1, 0, entry); } \
				fs.writeFileSync(p, lines.join("\n")); \
			} \
		} \
		if (fs.existsSync(".claude/settings.json") || fs.existsSync(".claude")) setEnvJson(".claude/settings.json", "MYCO_CMD", "myco-dev"); \
		if (fs.existsSync(".cursor/mcp.json")) setEnvJson(".cursor/mcp.json", "MYCO_CMD", "myco-dev"); \
		if (fs.existsSync(".codex/config.toml")) setEnvToml(".codex/config.toml", "MYCO_CMD", "myco-dev");'
	@echo "✓ myco-dev linked to local build"
	@echo "✓ myco-run linked for hook commands"
	@echo "✓ MYCO_CMD=myco-dev set in all configured agent settings"

dev-unlink:
	@rm -f $(HOME)/.local/bin/myco-dev
	@rm -f $(HOME)/.local/bin/myco-run
	@node -e '\
		const fs = require("fs"); \
		function clearEnvJson(p, key) { \
			try { \
				const s = JSON.parse(fs.readFileSync(p, "utf-8")); \
				if (s.env) { delete s.env[key]; } \
				fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n"); \
			} catch {} \
		} \
		function clearEnvToml(p, key) { \
			try { \
				let raw = fs.readFileSync(p, "utf-8"); \
				const lines = raw.split("\n").filter(l => !l.startsWith(key + " =")); \
				fs.writeFileSync(p, lines.join("\n")); \
			} catch {} \
		} \
		clearEnvJson(".claude/settings.json", "MYCO_CMD"); \
		clearEnvJson(".cursor/mcp.json", "MYCO_CMD"); \
		clearEnvToml(".codex/config.toml", "MYCO_CMD");'
	@echo "✓ myco-dev and myco-run unlinked"
	@echo "✓ MYCO_CMD removed from all agent settings"
