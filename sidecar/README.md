# Sidecar

The sidecar is a Docker image that installs, builds, tests, packages, and publishes this extension. Everything else, including editing and `F5` debugging, happens on the host. Docker never touches the editor or the debugger.

## Orientation

Debugging the extension needs a VS Code window on the host. `F5` (the “Ceedling” configuration in [`.vscode/launch.json`](../.vscode/launch.json)) opens a second, GUI-attached window, the Extension Development Host. A devcontainer can’t provide one: it has no display server. An earlier devcontainer setup also lacked a build step and the system libraries the tests need.

So the work splits in two. The host runs VS Code, the editor, `F5` debugging, and any coding assistant, all on the host checkout. The sidecar provides a pinned, reproducible Linux environment for the rest: installing dependencies, building, testing, packaging, and publishing.

## The image

`sidecar/Dockerfile` builds a local image named `vscode-ceedling-sidecar`. It contains:

- Node 22.
- Xvfb, plus the Chromium and Electron libraries `@vscode/test-electron` needs to run a real, headless VS Code for the integration tests.
- [`just`](https://github.com/casey/just), so the same recipes work from the host and inside a container.

The image holds none of the repository. The checkout is bind-mounted when a container runs. The image needs rebuilding only when `sidecar/Dockerfile` changes, and each recipe’s dependency on `just image` does that automatically.

## Using it through the Justfile

Every interaction goes through the root `Justfile`. `just --list` shows its recipes: `install`, `build`, `watch`, `rebuild`, `test`, `lint`, `coverage`, `validate`, `package`, `publish`, `clean`, `shell`, and `image`. Don’t run `docker` directly. The recipes handle image builds, volume mounts, and environment forwarding consistently.

Recipes run in one of two modes.

**One-shot from the host.** `just build`, `just test`, and the rest each start a fresh container, run one command, and remove the container. Two named Docker volumes persist between these runs: `node_modules`, and the downloaded test copy of VS Code (`.vscode-test`). Keeping `node_modules` in a volume also keeps its Linux binaries apart from the host’s own, such as a macOS `node_modules`.

**Interactively in one container.** `just shell` opens a session in the same image, with the same volumes. Inside it, the same recipe names work directly. Each recipe detects that it already runs in the container (the `SIDECAR` environment variable) and runs its command in place, without nesting another container. This saves container startup when running `just test` repeatedly.

## Common workflows

- **First-time setup:** `just install`.
- **Iterating:** `just build`, `just watch`, or `just test`.
- **Finding what to fix:** `just lint` and `just coverage`. See [docs/Development.md](../docs/Development.md#linting-and-coverage).
- **Validating against real Ceedling:** `just validate <version>`, from the host. It compiles the tests here, then runs them in a Ceedling release’s image with this image’s Node. See [docs/Development.md](../docs/Development.md#5-validation-against-real-ceedling).
- **Releasing:** `just package` produces a `.vsix`. `VSCE_PAT=<token> just publish` publishes it, and fails at once if `VSCE_PAT` isn’t set.
- **Repeated runs:** `just shell`, then `just build`, `just test`, or plain `npm` commands as often as needed.

## Verifying the extension itself

The sidecar doesn’t replace `F5`. To see a change working in VS Code, debug the extension on the host. See [docs/Development.md](../docs/Development.md) and [`.vscode/launch.json`](../.vscode/launch.json).
