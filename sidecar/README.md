# Sidecar

## Why this exists

Debugging this extension in the Extension Development Host (`F5` → "Ceedling" in
[`.vscode/launch.json`](../.vscode/launch.json)) requires a GUI-attached VS Code process on the
host. This repo used to run extension development inside a `.devcontainer/`, but that setup
actively fought the debugger: a devcontainer has no display server and no built-in support for
spawning the second, GUI-attached window that `extensionHost` debug launches need, and it also
lacked a build step and the system libraries required to run tests.

The sidecar removes Docker from that loop entirely. VS Code, the editor, `F5` debugging, and
Claude all operate directly on the host checkout — nothing here touches that process. Docker is
used only for the pieces that benefit from a pinned, reproducible Linux environment: installing
dependencies, building, testing, packaging, and publishing.

## What the image is

`sidecar/Dockerfile` builds a local image (`vscode-ceedling-sidecar`) containing:

- Node 22
- Xvfb plus the Chromium/Electron runtime libraries `@vscode/test-electron` needs to launch a
  real (headless) VS Code instance for the integration tests
- [`just`](https://github.com/casey/just), so the same recipes work both from the host and from
  inside a running container (see below)

Nothing in the repo is baked into the image — source is bind-mounted at container run time, so
the image only needs rebuilding when `sidecar/Dockerfile` itself changes (the root `Justfile`
does this automatically via each recipe's dependency on `just image`).

## Using it: the root Justfile

All interaction goes through the `Justfile` at the repo root — see `just --list` for the full
recipe set (`install`, `build`, `watch`, `rebuild`, `test`, `package`, `publish`, `clean`, `shell`,
`image`). Don't invoke `docker` directly; the recipes handle image builds, volume mounts, and
environment forwarding consistently.

Two supported ways to run them:

**One-shot from the host.** `just build`, `just test`, etc. each start a fresh, disposable
container, run one command, and remove the container. Dependencies (`node_modules`) and the
downloaded test-VS Code binary (`.vscode-test`) persist across these disposable runs in named
Docker volumes, not in the container itself or in the host's own `node_modules` — this also keeps
the container's Linux-native dependency binaries from colliding with your host's (e.g. macOS)
`node_modules`.

**Interactively, inside a live container.** `just shell` opens an interactive session in the same
image, with the same volumes mounted. Because `just` is installed in the image, the *same* recipe
names work directly inside that shell (`just build`, `just test`, ...) — they detect they're
already inside the container and run the underlying command directly instead of trying to launch
another nested Docker container. This is useful for iterating (e.g. re-running `just test`
repeatedly) without paying container-startup cost on every command.

## Common workflows

- **First-time setup**: `just install`
- **Iterating on the extension**: `just build`, `just watch`, or `just test`
- **Cutting a release**: `just package` to produce a `.vsix`, then `VSCE_PAT=<token> just publish`
  to publish it (fails fast with a clear error if `VSCE_PAT` isn't set)
- **Poking around / repeated runs**: `just shell`, then run `just build` / `just test` / plain npm
  commands as many times as needed inside that one container

## Verifying the extension itself

None of the above replaces `F5`. To confirm your changes actually work in VS Code, debug the
extension normally from the host — see the root [README](../README.md) and
[`.vscode/launch.json`](../.vscode/launch.json).
