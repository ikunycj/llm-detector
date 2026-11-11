# Optional Terminal Bench runtime

Run `make terminal-bench-install` from the repository root to install the pinned Harbor CLI into this directory's `.venv`. This module is independent of the Go/React application and is not installed during normal application startup.

- Runtime: Python 3.12, Harbor 0.25.0, Docker + Docker Compose, Git.
- Dependency resolution: `pyproject.toml` + `uv.lock`.
- Dataset: Terminal-Bench 2.0, exact source commit and 89 task identities in `internal/terminalbench/catalog.json`.
- Day-to-day subset: the six task IDs in the catalog's `daily` field; no aliases or replacements.
- No model calls occur during installation or environment checks.

See [the integration guide](../../docs/terminal-bench.md) for execution, credentials, cancellation and result semantics.
