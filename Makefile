.PHONY: build check test lint clean watch install

build: check
	npm run build
	cp src/prompts/*.md dist/src/prompts/

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
