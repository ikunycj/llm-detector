.PHONY: backend frontend install init-env test build clean

init-env:
	@if [ ! -f .env ] || grep -q '^APP_LOGIN_KEY=replace-with-a-long-random-key$$' .env; then \
		key=$$(openssl rand -hex 32) && \
		sed "s/^APP_LOGIN_KEY=.*/APP_LOGIN_KEY=$$key/" .env.example > .env && \
		chmod 600 .env && \
		echo 'Created a private development login key in .env.'; \
	fi
	@grep -Eq '^APP_LOGIN_KEY=.+$$' .env || { echo 'APP_LOGIN_KEY is empty in .env.' >&2; exit 1; }

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
