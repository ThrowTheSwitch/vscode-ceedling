# Development

This document is for contributors changing this extension’s own code. It covers: the daily workflow, running and debugging locally, key VS Code features, manual testing, and the sidecar.

---

## 1. Development Workflow

Edit source on the host. Use the sidecar for everything else.

The loop is: edit, build, F5, iterate, test, commit.

Source edits happen directly on the host. They happen in your real VS Code window. Docker never touches that window.

The sidecar handles install, build, test, package, and publish. It runs in Docker. See [Section 5](#5-the-sidecar).

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

For runtime errors and logs, check the Output channel. It is named "Ceedling Explorer". Find it in the second window. See [Viewing Extension Logs](#viewing-extension-logs) for how to control its detail.

F5 runs in development mode. Development mode adds `--verbosity debug` to test runs and debug compiles. It logs their raw stdout and stderr to that channel. A packaged install never does this.

## 3. Key VS Code Features for This Work

A small, fixed set of VS Code features covers nearly all of this repo’s dev and debug needs.

### Extension Development Host

The second window F5 opens. This extension runs under test inside it.

### Breakpoints and the Debug Console

Set breakpoints in `src/*.ts`. They hit in the Development Host.

### Viewing Extension Logs

The "Ceedling Explorer" Output channel holds this extension’s own runtime log.

Open it from the Output panel, in the second window.

The Output panel has its own level filter. It controls what you see for the channel you're viewing.

For a choice that persists, use the Command Palette instead. Run "Developer: Set Log Level...". Pick "Ceedling Explorer". Pick a level: Trace, Debug, Info, Warning, Error, or Off.

Trace shows the most detail. It includes every raw Ceedling invocation this extension makes.

Development mode adds detail of its own, on top of this. See [Section 2](#troubleshooting).

### Reload Window

Command Palette command. The fastest way to pick up a rebuild.

### Toggle Developer Tools

Command Palette command. For rendering-level issues. Rarely needed here.

### Show Running Extensions

Command Palette command. Shows activation time and CPU per extension.

This extension activates on every window. Its `activationEvents` is `["onStartupFinished"]`. Use this command to check that cost.

### The Testing View

This is the extension’s own UI under test. Open it, inside the Development Host, to see your changes.

### The Problems Panel

Shows this repo’s own TypeScript build errors. The extension has a separate problem-matching feature for Ceedling’s users. Do not confuse the two.

### Driving the Extension’s Features

Exercising the extension needs a real Ceedling project, open as its own workspace.

This repo ships one, at [`tests/manual/`](../tests/manual/).

In the Development Host: File, Open Folder, pick `tests/manual/`.

This is a separate workspace from this repo’s own root. This repo’s own `.vscode/launch.json` launches the Development Host itself, one level up. `tests/manual/`’s own `.vscode/launch.json` is what the extension uses inside that second window.

Open the Testing view. It discovers the tests in `test_calculator.c` and `test_calculator_parametrized.c`.

Click the refresh icon to re-discover after an edit.

Run all test cases. Each shows its state.

* `test_calculator.c`: One passes. One fails. One is ignored.
* `test_calculator_parametrized.c`: All parameterized test cases pass.

Click a single test’s gutter icon to run just that test. Ceedling still recompiles the whole file — `--test-case` narrows what runs and gets reported, not what gets built. A parametrized function’s cases always run together; Ceedling’s filter can isolate one function, not one case within it.

Click a test’s debug icon to debug it. A breakpoint in `src/Calculator.c` hits through the VS Code debugger.

Try the Clean and Clobber buttons, in the Testing view’s own toolbar.

Introduce a syntax error in `test_calculator.c`. Save. Run the test again. The error lands in the Problems panel. `tests/manual/.vscode/settings.json` already enables problem matching for this. Revert the edit after.

Run `test_calculator_crash.c`. `test_should_crash` dereferences a null pointer. `project.yml`’s `:use_backtrace` ⇒ `:simple` setting catches the crash and reports it as a normal failed test at the exact crashing line instead of a bare timeout or a silently stopped run.

See [tests/manual/README.md](../tests/manual/README.md) for the `project.yml` settings the parametrized and crash tests need.

## 4. Manual Testing Plan

This is a repeatable checklist. Run it after a change that could affect the extension’s runtime behavior.

All steps run against [`tests/manual/`](../tests/manual/), opened as its own folder in the Development Host.

- [ ] **Discovery.** The Testing view lists all test files. Confirms parsing and discovery both work.
- [ ] **Run all.** One test passes, one fails, one is ignored. Each shows the correct message.
- [ ] **Run one.** A single test runs in isolation, from its gutter icon. The Ceedling Explorer log (Trace level) shows `--test-case=` in the invocation.
- [ ] **Debug.** A breakpoint in `src/Calculator.c` is hit, from a test’s debug icon.
- [ ] **Clean.** The Testing view’s Clean button clears `build/`.
- [ ] **Clobber.** The Clobber button does a harder reset. It also succeeds.
- [ ] **Problem matching.** A deliberate syntax error in `test_calculator.c` surfaces in the Problems panel. It squiggles at the error line. The Testing view’s own message for the erroring test shows the same compiler message, not a bare `stdout:` label. Revert the edit after.
- [ ] **Settings change.** Toggle `ceedlingExplorer.prettyTestLabel` to `true` in `tests/manual/.vscode/settings.json`. Refresh. Labels shorten. No full window reload was needed.
- [ ] **Parametrized test.** All cases in `test_calculator_parametrized.c` pass, on both Ceedling 1.0.0 and 1.1.0.
- [ ] **Crash handling.** `test_should_crash` in `test_calculator_crash.c` shows as a failed test, at the exact crashing line, on both Ceedling 1.0.0 and 1.1.0.
- [ ] **Crash log link.** With Ceedling 1.1.0 running on a platform that supports `gdb`, set `:use_backtrace:` ⇒ `:gdb` in `project.yml` and re-run `test_should_crash`. Its failure message ends with a clickable link to the gdb log file. Revert the setting after.
- [ ] **Diagnostics don’t go stale.** Introduce a syntax error, run just `test_add_should_ReturnSum` alone from its gutter icon. Confirm the error appears in the Problems panel. Fix the error, then run the whole file (not that same test again). Confirm the Problems panel entry is gone.

## 5. The Sidecar

The sidecar is Docker for everything except F5. It never touches the debug loop.

### Why it exists

Development inside a devcontainer can conflict with the debugger. A devcontainer has no display server. It has no built-in support for the second GUI window a debug launch needs.

The sidecar removes Docker from that loop entirely. F5 and VS Code always run on the host.

### What’s in the image

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

`node_modules` and the downloaded test-VS Code binary persist in named Docker volumes. They do not live in the container. They do not live in the host’s own `node_modules`.

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
- [tests/manual/README.md](../tests/manual/README.md) — the manual test project itself.
- [sidecar/README.md](../sidecar/README.md) — the sidecar’s own fuller explanation.
- [.github/workflows/cd.yml](../.github/workflows/cd.yml) — the release process itself.
