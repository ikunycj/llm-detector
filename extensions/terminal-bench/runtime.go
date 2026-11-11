// Package benchenv embeds the same pinned dependency manifests used by make.
package benchenv

import _ "embed"

//go:embed pyproject.toml
var Project []byte

//go:embed uv.lock
var Lock []byte
