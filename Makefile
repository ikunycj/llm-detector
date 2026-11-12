.PHONY: backend frontend install init-env test build clean terminal-bench-install local-runner-build

init-env:
	python3 scripts/init_env.py

backend: init-env
	go run ./cmd/server

frontend: init-env
	cd web && npm run dev

install:
	npm ci --prefix web

test:
	go test ./...
	npm run typecheck --prefix web

build:
	mkdir -p bin
	go build -o bin/server ./cmd/server
	npm run build --prefix web

clean:
	rm -rf bin web/dist

terminal-bench-install:
	uv sync --project extensions/terminal-bench --locked --python 3.12

local-runner-build:
	python3 scripts/package_local.py
