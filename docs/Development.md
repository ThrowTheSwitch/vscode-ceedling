# Development

This document is for contributors changing this extension's own code. It covers: the daily workflow, running and debugging locally, key VS Code features, and the sidecar.

---

## 1. Development Workflow

Edit source on the host. Use the sidecar for everything else.

The loop is: edit, build, F5, iterate, test, commit.

Source edits happen directly on the host. They happen in your real VS Code window. Docker never touches that window.

The sidecar handles install, build, test, package, and publish. It runs in Docker. See [Section 4](#4-the-sidecar).

First time: run `just install`. Then press F5.

Ongoing: run `just watch` in one terminal. Press F5 to try a change. Run `just test` before committing.

## 2. Running the Extension Locally

F5 launches a second VS Code window. This extension runs inside that window.

The launch config is named "Ceedling". It lives in `.vscode/launch.json`. It is an `extensionHost` launch.

A build must exist first. `just build` or `just watch` produces `out/src/main.js`.

To pick up a new build, reload the second window. Use Developer: Reload Window. No need to restart the debug session.

Breakpoints work directly in `src/*.ts`. The second window runs the built JS. Source maps map it back to your TypeScript.

The fast loop: keep `just watch` running, edit, Reload Window. The slow loop: a fresh F5 each time.

### Troubleshooting

Behavior looks stale: rebuild, then Reload Window.

Nothing loads: same fix.

For runtime errors and logs, check the Output channel. It is named "Ceedling Explorer". Find it in the second window.

F5 runs in development mode. Development mode adds `--verbosity debug` to test runs and debug compiles. It logs their raw stdout and stderr to that channel. A packaged install never does this.

The Output channel's log level is adjustable. Use its own gear icon. No code change is needed to see more or less detail.

## 3. Key VS Code Features for This Work

A small, fixed set of VS Code features covers nearly all of this repo's dev and debug needs.

**Extension Development Host.** The second window F5 opens. This extension runs under test inside it.

**Breakpoints and the Debug Console.** Set breakpoints in `src/*.ts`. They hit in the Development Host.

**The "Ceedling Explorer" Output channel.** This extension's own runtime log. See [Section 2](#troubleshooting).

**Developer: Reload Window.** Command Palette command. The fastest way to pick up a rebuild.

**Developer: Toggle Developer Tools.** Command Palette command. For rendering-level issues. Rarely needed here.

**The Testing view, inside the Development Host.** This is the extension's own UI under test. Open it to see your changes.

**The Problems panel.** Shows this repo's own TypeScript build errors. The extension has a separate problem-matching feature for Ceedling's users. Do not confuse the two.

## 4. The Sidecar

The sidecar is Docker for everything except F5. It never touches the debug loop.

### Why it exists

Development inside a devcontainer can conflict with the debugger. A devcontainer has no display server. It has no built-in support for the second GUI window a debug launch needs.

The sidecar removes Docker from that loop entirely. F5 and VS Code always run on the host.

### What's in the image

The image is `vscode-ceedling-sidecar`. It builds from `sidecar/Dockerfile`. It contains:

- Node 22
- Xvfb, plus the Electron libraries the integration tests need
- `just` itself

Nothing in the repo is baked into the image. Source is bind-mounted at run time. The image only needs rebuilding when `sidecar/Dockerfile` itself changes.

### How to use it

All interaction goes through the Justfile. Never call `docker` directly.

There are two modes.

**One-shot from the host.** Commands like `just build` or `just test` work the same way: start a fresh container, run one command, remove the container.

**Interactive.** `just shell` opens a live session in the same image. The same recipe names work directly inside it. `just` detects it is already in the container.

`node_modules` and the downloaded test-VS Code binary persist in named Docker volumes. They do not live in the container. They do not live in the host's own `node_modules`.

### Most needed recipes

| Recipe | Does |
|---|---|
| `just install` | First-time setup |
| `just build` | One-shot build |
| `just watch` | Continuous rebuild on save |
| `just test` | Runs the unit suite, then the integration suite, headless via Xvfb |
| `just package` | Produces a `.vsix` |
| `just publish` | Publishes to the Marketplace. Requires `VSCE_PAT` |
| `just shell` | Opens an interactive container session |
| `just clean` | Removes build output |

---

## See also

- [README.md](../README.md) — end-user features and configuration.
- [CHANGELOG.md](../CHANGELOG.md), [ReleaseNotes.md](ReleaseNotes.md), [KnownIssues.md](KnownIssues.md), [BreakingChanges.md](BreakingChanges.md) — release-facing docs.
- [sidecar/README.md](../sidecar/README.md) — the sidecar's own fuller explanation.
- [.github/workflows/cd.yml](../.github/workflows/cd.yml) — the release process itself.
